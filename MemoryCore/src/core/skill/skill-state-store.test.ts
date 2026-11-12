import { mkdtempSync, rmSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AtomicSkillStateStore,
  MongoSkillStateStore,
  SqliteSkillStateStore,
} from "./skill-state-store.js";

type Fixture = {
  store: AtomicSkillStateStore;
  another: () => AtomicSkillStateStore;
  corrupt: (key: string) => Promise<void>;
  close: () => Promise<void>;
};

function contract(name: string, open: () => Promise<Fixture>) {
  describe(name, () => {
    let fixture: Fixture;
    let store: AtomicSkillStateStore;
    beforeEach(async () => {
      fixture = await open();
      store = fixture.store;
      await store.init();
    });
    afterEach(async () => { await fixture?.close(); });

    it("initializes idempotently and reads absent keys as null", async () => {
      await Promise.all([store.init(), fixture.another().init()]);
      expect(await store.read("absent")).toBeNull();
      expect(await store.compareAndSet("absent", 1, {})).toBe(false);
      expect(await store.remove("absent", 1)).toBe(false);
    });

    it("has exactly one concurrent creator and never replaces its payload", async () => {
      const stores = [store, fixture.another()];
      await stores[1].init();
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
        stores[i % 2].create("claim", { candidate: i })));
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = results.indexOf(true);
      expect(await store.read("claim")).toEqual({ revision: 1, value: { candidate: winner } });
      expect(await store.create("claim", { different: true })).toBe(false);
      expect(await store.read("claim")).toEqual({ revision: 1, value: { candidate: winner } });
    });

    it("has exactly one concurrent CAS winner for a revision", async () => {
      await store.create("cas", { initial: true });
      const second = fixture.another();
      await second.init();
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? store : second).compareAndSet("cas", 1, { candidate: i })));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await store.read("cas")).toEqual({ revision: 2, value: { candidate: results.indexOf(true) } });
      expect(await store.compareAndSet("cas", 1, "stale")).toBe(false);
      expect(await store.compareAndSet("cas", 2, "next")).toBe(true);
      expect(await store.read("cas")).toEqual({ revision: 3, value: "next" });
    });

    it("preserves data for another instance and detaches input and output references", async () => {
      const value = { nested: { data: [1, 2] } };
      await store.create("persist", value);
      value.nested.data.push(3);
      const second = fixture.another();
      await second.init();
      const record = await second.read("persist");
      expect(record).toEqual({ revision: 1, value: { nested: { data: [1, 2] } } });
      (record!.value as typeof value).nested.data.push(4);
      const page = await second.list("persist");
      (page.items[0].value as typeof value).nested.data.push(5);
      expect(await store.read("persist")).toEqual({ revision: 1, value: { nested: { data: [1, 2] } } });
    });

    it("paginates literal prefixes in binary key order with exclusive cursors", async () => {
      const prefix = "scope.[a]+($)^?*{x}|\\%_😀/";
      const keys = ["z", "A", "b", "a"].map(suffix => prefix + suffix);
      for (const key of [...keys, "scopeXa/", "other/a", prefix.slice(0, -1)]) {
        await store.create(key, { key });
      }
      const first = await store.list(prefix, { limit: 2 });
      expect(first.items.map(item => item.key)).toEqual([prefix + "A", prefix + "a"]);
      expect(first.next).toBe(prefix + "a");
      const second = await store.list(prefix, { limit: 2, after: first.next });
      expect(second.items.map(item => item.key)).toEqual([prefix + "b", prefix + "z"]);
      expect(second.next).toBeUndefined();
      expect(await store.list(prefix, { after: prefix + "zz" })).toEqual({ items: [] });
      expect((await store.list(prefix, { after: "!" })).items).toHaveLength(4);
      expect((await store.list("", { limit: 1000 })).items).toHaveLength(7);
    });

    it("does not let stale remove delete newer data", async () => {
      await store.create("remove", "old");
      await store.compareAndSet("remove", 1, "new");
      expect(await store.remove("remove", 1)).toBe(false);
      expect(await store.read("remove")).toEqual({ revision: 2, value: "new" });
      expect(await store.remove("remove", 2)).toBe(true);
      expect(await store.read("remove")).toBeNull();
    });

    it("round trips JSON primitives and nested plain values", async () => {
      const values = [null, true, false, 0, 1.5, "文本", [null, { a: 1 }], { "__proto__": null }];
      for (const [i, value] of values.entries()) {
        await store.create(`json/${i}`, value);
        expect((await store.read(`json/${i}`))?.value).toEqual(value);
      }
    });

    it("rejects non-JSON and oversized payloads before changing data", async () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      const inheritedToJson = Object.setPrototypeOf([], { toJSON: () => "not an array" });
      const invalid = [undefined, NaN, Infinity, 1n, Symbol("x"), () => 1,
        { nested: undefined }, [undefined], new Date(), new Map(), cyclic, inheritedToJson,
        new Array(2), { toJSON: () => "hidden" }, "x".repeat(1024 * 1024)];
      await store.create("valid", "original");
      for (const value of invalid) {
        await expect(store.create("invalid", value)).rejects.toThrow(/JSON|byte|depth/i);
        await expect(store.compareAndSet("valid", 1, value)).rejects.toThrow(/JSON|byte|depth/i);
      }
      expect(await store.read("invalid")).toBeNull();
      expect(await store.read("valid")).toEqual({ revision: 1, value: "original" });
    });

    it("rejects sparse arrays even when named properties disguise the missing indices", async () => {
      const value = Object.assign(new Array(1), { extra: "lost by JSON.stringify" });
      await expect(store.create("sparse", value)).rejects.toThrow(/JSON/i);
      expect(await store.read("sparse")).toBeNull();
    });

    it("enforces the UTF-8 JSON size boundary, not string character count", async () => {
      const exact = "x".repeat(1024 * 1024 - 2);
      expect(await store.create("max-size", exact)).toBe(true);
      expect((await store.read("max-size"))?.value).toBe(exact);
      await expect(store.create("too-many-bytes", "中".repeat(400_000))).rejects.toThrow(/byte/i);
    });

    it("rejects excessive nesting, accessors, symbols and hidden properties", async () => {
      let deep: unknown = null;
      for (let i = 0; i < 102; i++) deep = [deep];
      const values = [deep, { get x() { throw new Error("must not execute accessor"); } },
        { [Symbol("hidden")]: 1 }, Object.defineProperty({}, "hidden", { value: 1 })];
      for (const value of values) await expect(store.create("invalid-shape", value)).rejects.toThrow(/JSON/i);
    });

    it("rejects invalid keys, revisions and pagination bounds consistently", async () => {
      for (const key of ["", "x".repeat(1025), "null\0key", "\ud800"]) {
        await expect(store.create(key, null)).rejects.toThrow(/key/i);
        await expect(store.read(key)).rejects.toThrow(/key/i);
      }
      for (const revision of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        await expect(store.compareAndSet("key", revision, {})).rejects.toThrow(/revision/i);
        await expect(store.remove("key", revision)).rejects.toThrow(/revision/i);
      }
      await expect(store.compareAndSet("key", Number.MAX_SAFE_INTEGER, {})).rejects.toThrow(/revision/i);
      expect(await store.remove("key", Number.MAX_SAFE_INTEGER)).toBe(false);
      for (const limit of [0, -1, 1.5, NaN, Infinity, 1001]) {
        await expect(store.list("", { limit })).rejects.toThrow(/limit/i);
      }
      await expect(store.list("x".repeat(1025))).rejects.toThrow(/prefix/i);
      await expect(store.list("", { after: "" })).rejects.toThrow(/after/i);
    });

    it("reads a batch in input order with missing, repeated and literal keys isolated", async () => {
      const key = "team-a/scope.[a]+%_😀";
      await store.create(key, { nested: { value: "a" } });
      await store.create("team-b/scope.[a]+%_😀", { value: "b" });
      await store.create("team-a/scopeXa", "not a literal match");
      await store.compareAndSet(key, 1, { nested: { value: "updated" } });
      const result = await store.readMany!(["missing", "team-b/scope.[a]+%_😀", key, key]);
      expect(result).toEqual([null, { revision: 1, value: { value: "b" } },
        { revision: 2, value: { nested: { value: "updated" } } }, { revision: 2, value: { nested: { value: "updated" } } }]);
      (result[2]!.value as { nested: { value: string } }).nested.value = "changed locally";
      expect(result[3]!.value).toEqual({ nested: { value: "updated" } });
      expect((await store.read(key))!.value).toEqual({ nested: { value: "updated" } });
      expect(await store.readMany!([])).toEqual([]);
      expect(await store.readMany!(Array(1000).fill(key))).toHaveLength(1000);
    });

    it("snapshots the requested key order before asynchronous database work", async () => {
      await store.create("first", 1);
      await store.create("second", 2);
      const keys = ["first", "second"];
      const pending = store.readMany!(keys);
      keys.reverse();
      expect(await pending).toEqual([{ revision: 1, value: 1 }, { revision: 1, value: 2 }]);
    });

    it("validates all batch keys and rejects oversized batches consistently", async () => {
      for (const key of ["", "x".repeat(1025), "nul\0key", "\ud800"]) {
        await expect(store.readMany!(["valid", key])).rejects.toThrow(/key/i);
      }
      await expect(store.readMany!(Array(1001).fill("key"))).rejects.toThrow(/1000|batch/i);
      await expect(store.readMany!(new Array(1))).rejects.toThrow(/key/i);
    });

    it("fails the entire batch when any requested record is corrupt", async () => {
      await store.create("valid", {});
      await store.create("corrupt", {});
      await fixture.corrupt("corrupt");
      await expect(store.readMany!(["valid", "missing", "corrupt"])).rejects.toThrow();
    });

    it("reports corrupt JSON rather than silently treating it as absent", async () => {
      await store.create("corrupt", null);
      await fixture.corrupt("corrupt");
      await expect(store.read("corrupt")).rejects.toThrow();
      await expect(store.list("corrupt")).rejects.toThrow();
    });
  });
}

contract("SqliteSkillStateStore (real SQLite)", async () => {
  const directory = mkdtempSync(join(tmpdir(), "skill-control-"));
  const path = join(directory, "metadata.sqlite");
  const databases: DatabaseSync[] = [];
  const connect = () => {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA busy_timeout = 5000");
    databases.push(db);
    return db;
  };
  const db = connect();
  return {
    store: new SqliteSkillStateStore(db),
    another: () => new SqliteSkillStateStore(connect()),
    corrupt: async key => { db.prepare("UPDATE skill_control SET value_json = ? WHERE key = ?").run("{broken", key); },
    close: async () => {
      for (const connection of databases) connection.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
});

describe("SQLite lifecycle and database errors", () => {
  it("uses bounded IN queries rather than one SQLite SELECT per key", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = new SqliteSkillStateStore(db);
      await store.init();
      await store.create("key-999", "last");
      const prepare = vi.spyOn(db, "prepare");
      const rows = await store.readMany(Array.from({ length: 1000 }, (_, i) => `key-${i}`));
      expect(rows[999]).toEqual({ revision: 1, value: "last" });
      expect(prepare.mock.calls.length).toBeLessThanOrEqual(4);
      expect(prepare.mock.calls.every(([sql]) => /\bIN\s*\(/i.test(sql))).toBe(true);
    } finally { db.close(); }
  });

  it("arbitrates create and CAS across independent worker threads and connections", async () => {
    const directory = mkdtempSync(join(tmpdir(), "skill-workers-"));
    const path = join(directory, "metadata.sqlite");
    const db = new DatabaseSync(path);
    const store = new SqliteSkillStateStore(db);
    await store.init();
    const workers: Worker[] = [];
    try {
      for (const operation of ["create", "compareAndSet"]) {
        const gate = new SharedArrayBuffer(4);
        const ready: Promise<void>[] = [];
        const results: Promise<{ won: boolean; candidate: number }>[] = [];
        for (let candidate = 0; candidate < 4; candidate++) {
          const worker = new Worker(`
            const { parentPort, workerData } = require("node:worker_threads");
            const { DatabaseSync } = require("node:sqlite");
            (async () => {
              const { tsImport } = await import(workerData.loader);
              const { SqliteSkillStateStore } = await tsImport(workerData.module, workerData.importer);
              const db = new DatabaseSync(workerData.path);
              db.exec("PRAGMA busy_timeout = 5000");
              const store = new SqliteSkillStateStore(db);
              parentPort.postMessage("ready");
              Atomics.wait(new Int32Array(workerData.gate), 0, 0);
              const won = workerData.operation === "create"
                ? await store.create("race", { candidate: workerData.candidate })
                : await store.compareAndSet("race", 1, { candidate: workerData.candidate });
              db.close();
              parentPort.postMessage({ won, candidate: workerData.candidate });
            })().catch(error => { throw error; });
          `, {
            eval: true,
            workerData: { path, gate, operation, candidate,
              loader: import.meta.resolve("tsx/esm/api"),
              module: new URL("./skill-state-store.ts", import.meta.url).href,
              importer: import.meta.url },
          });
          workers.push(worker);
          ready.push(new Promise((resolve, reject) => {
            worker.once("error", reject);
            worker.once("message", () => resolve());
          }));
          results.push(new Promise((resolve, reject) => {
            worker.once("error", reject);
            worker.on("message", message => { if (message !== "ready") resolve(message); });
          }));
        }
        const [, outcomes] = await Promise.all([
          Promise.all(ready).then(() => {
            Atomics.store(new Int32Array(gate), 0, 1);
            Atomics.notify(new Int32Array(gate), 0);
          }),
          Promise.all(results),
        ]);
        const winners = outcomes.filter(result => result.won);
        expect(winners).toHaveLength(1);
        expect(await store.read("race")).toEqual({
          revision: operation === "create" ? 1 : 2, value: { candidate: winners[0].candidate },
        });
      }
    } finally {
      await Promise.all(workers.map(worker => worker.terminate()));
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists across closing and reopening the database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "skill-restart-"));
    const path = join(directory, "metadata.sqlite");
    let db = new DatabaseSync(path);
    try {
      const first = new SqliteSkillStateStore(db);
      await first.init();
      await first.create("persist", { committed: true });
      db.close();
      db = new DatabaseSync(path);
      const reopened = new SqliteSkillStateStore(db);
      await reopened.init();
      expect(await reopened.read("persist")).toEqual({ revision: 1, value: { committed: true } });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not swallow failed init, reads or writes", async () => {
    const db = new DatabaseSync(":memory:");
    const store = new SqliteSkillStateStore(db);
    await store.init();
    db.close();
    for (const operation of [() => store.init(), () => store.read("key"), () => store.readMany(["key"]), () => store.create("key", {}),
      () => store.compareAndSet("key", 1, {}), () => store.remove("key", 1), () => store.list("")]) {
      await expect(operation()).rejects.toThrow();
    }
  });
});

describe("MongoSkillStateStore (real standalone MongoDB)", () => {
  let server: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;
  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    client = await new MongoClient(server.getUri()).connect();
    db = client.db("skill_state_contract");
  });
  afterAll(async () => {
    await client?.close();
    await server?.stop();
  });

  contract("single-document atomic operations", async () => {
    await db.dropDatabase();
    return {
      store: new MongoSkillStateStore(db),
      another: () => new MongoSkillStateStore(db),
      corrupt: async key => {
        await db.collection<{ _id: string; value_json: string }>("skill_control")
          .updateOne({ _id: key }, { $set: { value_json: "{broken" } });
      },
      close: async () => {},
    };
  });

  it("uses one real MongoDB $in query for a batch, not findOne per key", async () => {
    const connection = await new MongoClient(server.getUri(), { monitorCommands: true }).connect();
    try {
      const store = new MongoSkillStateStore(connection.db("skill_batch_commands"));
      await store.init();
      await store.create("key-999", "last");
      const filters: unknown[] = [];
      connection.on("commandStarted", event => { if (event.commandName === "find") filters.push(event.command.filter); });
      const keys = Array.from({ length: 1000 }, (_, i) => `key-${i}`);
      const result = await store.readMany(keys);
      expect(result[999]).toEqual({ revision: 1, value: "last" });
      expect(filters).toEqual([{ _id: { $in: keys } }]);
    } finally { await connection.close(); }
  });

  it("propagates a server validation error rather than treating it as a duplicate", async () => {
    const validationDb = client.db("skill_validation");
    await validationDb.createCollection("skill_control", { validator: { forbidden: { $exists: true } } });
    const store = new MongoSkillStateStore(validationDb);
    await store.init();
    await expect(store.create("key", {})).rejects.toMatchObject({ code: 121 });
  });

  it("propagates disconnected-client failures for every database operation", async () => {
    const connection = await new MongoClient(server.getUri()).connect();
    const store = new MongoSkillStateStore(connection.db("skill_closed"));
    await store.init();
    await connection.close();
    for (const operation of [() => store.init(), () => store.read("key"), () => store.readMany(["key"]), () => store.create("key", {}),
      () => store.compareAndSet("key", 1, {}), () => store.remove("key", 1), () => store.list("")]) {
      await expect(operation()).rejects.toThrow();
    }
  });
});
