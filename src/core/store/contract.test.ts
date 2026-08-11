/**
 * One contract, two backends (tz-03 критерий 5, инвариант `backend-parity`).
 *
 * The suite runs against the REAL SqliteMemoryStore and the REAL
 * TcvdbMemoryStore — the latter over a local HTTP fake of the TCVDB API, so
 * the code under test is `tcvdb.ts` itself and not a stub written to agree
 * with it.
 *
 * Scope is the counting surface this package depends on: upsertL1, countL1,
 * deleteL1Batch, deleteL1Expired. Search and embedding parity are somebody
 * else's package.
 *
 * DEGRADATIONS is DATA, and the test is symmetric about it: a declared
 * degradation that does not reproduce fails exactly like an undeclared
 * difference. A decorative list would pass both ways, which is the failure
 * mode ТЗ S4 :126 asks about.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "./sqlite.js";
import { TcvdbMemoryStore } from "./tcvdb.js";
import { startTcvdbFake, type TcvdbFake } from "./tcvdb-fake.js";
import { request } from "undici";
import type { IMemoryStore } from "./types.js";
import type { MemoryRecord } from "../record/l1-writer.js";
import { passesScope } from "../hooks/auto-recall/scope.js";

/**
 * Known, deliberate differences between the backends. Each one is asserted
 * below — remove a real entry and the test fails; add an imaginary one and it
 * fails too.
 */
const DEGRADATIONS = {
  /** Full-text search: sqlite ships FTS5; TCVDB needs the BM25 encoder, which
   * is not configured here, so it degrades. A REAL difference. */
  ftsSearch: { sqlite: true, tcvdb: false },
  /** Neither backend offers server-side hybrid search in this configuration. */
  nativeHybridSearch: { sqlite: false, tcvdb: false },
  /** Sparse vectors need the BM25 encoder — absent on both here. */
  sparseVectors: { sqlite: false, tcvdb: false },
  /** The >80% TTL guard exists on BOTH (sqlite.ts:1458, tcvdb.ts:535). It is
   * listed as parity, not as a degradation: an earlier draft declared it as
   * TCVDB-only and this test failed, which is the whole point of the list. */
  ttlSafetyThreshold: { sqlite: true, tcvdb: true },
};

// Probe d4 drives these: a list nobody can break is a list nobody can trust.
//   FALSIFY=drop-degradation — a REAL difference disappears from the list.
//   FALSIFY=fake-degradation — a difference that does not exist is declared.
if (process.env.FALSIFY === "drop-degradation") {
  DEGRADATIONS.ftsSearch = { sqlite: true, tcvdb: true };
} else if (process.env.FALSIFY === "fake-degradation") {
  DEGRADATIONS.sparseVectors = { sqlite: true, tcvdb: false };
}

let dir: string;
let fake: TcvdbFake;
let sqlite: IMemoryStore;
let tcvdb: IMemoryStore;

function record(id: string, updatedAt: string): MemoryRecord {
  return {
    id,
    content: `content of ${id}`,
    type: "episodic",
    priority: 50,
    scene_name: "scene",
    source_message_ids: [],
    metadata: {},
    timestamps: [updatedAt],
    createdAt: updatedAt,
    updatedAt,
    sessionKey: "s",
    sessionId: "s1",
  } as MemoryRecord;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "contract-"));
  fake = await startTcvdbFake();
  sqlite = new VectorStore(path.join(dir, "vectors.db"), 8);
  await sqlite.init();
  tcvdb = new TcvdbMemoryStore({
    url: fake.url,
    username: "u",
    apiKey: "k",
    database: "testdb",
    embeddingModel: "m",
    timeout: 5000,
  });
  await tcvdb.init();
});

afterAll(async () => {
  sqlite.close();
  tcvdb.close();
  await fake.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function bothBackends(): Array<[string, () => IMemoryStore]> {
  return [
    ["sqlite", () => sqlite],
    ["tcvdb", () => tcvdb],
  ];
}

describe.each(bothBackends())("IMemoryStore contract — %s", (name, get) => {
  it("counts what was upserted", async () => {
    const store = get();
    const before = await store.countL1();
    await store.upsertL1(record(`${name}-1`, "2026-08-01T00:00:00.000Z"));
    await store.upsertL1(record(`${name}-2`, "2026-08-02T00:00:00.000Z"));
    expect(await store.countL1()).toBe(before + 2);
  });

  it("upsert of the same id replaces rather than duplicates", async () => {
    const store = get();
    const before = await store.countL1();
    await store.upsertL1(record(`${name}-1`, "2026-08-03T00:00:00.000Z"));
    expect(await store.countL1()).toBe(before);
  });

  it("deleteL1Batch removes exactly the named ids", async () => {
    const store = get();
    const before = await store.countL1();
    await store.upsertL1(record(`${name}-tmp`, "2026-08-01T00:00:00.000Z"));
    expect(await store.deleteL1Batch([`${name}-tmp`])).toBe(true);
    expect(await store.countL1()).toBe(before);
  });

  it("countL1 is the number both the counters and the dashboard trust", async () => {
    const store = get();
    const count = await store.countL1();
    expect(Number.isInteger(count)).toBe(true);
    expect(count).toBeGreaterThanOrEqual(0);
  });
});

describe("declared degradations", () => {
  it("capabilities match the list on BOTH backends, in both directions", () => {
    const caps = {
      sqlite: sqlite.getCapabilities(),
      tcvdb: tcvdb.getCapabilities(),
    };
    for (const flag of [
      "ftsSearch",
      "nativeHybridSearch",
      "sparseVectors",
    ] as const) {
      expect([flag, caps.sqlite[flag]]).toEqual([
        flag,
        DEGRADATIONS[flag].sqlite,
      ]);
      expect([flag, caps.tcvdb[flag]]).toEqual([
        flag,
        DEGRADATIONS[flag].tcvdb,
      ]);
    }
  });

  it("the >80% TTL guard is declared as parity and behaves as parity", async () => {
    // Everything is older than the cutoff, so a sweep would remove 100%.
    const cutoff = "2027-01-01T00:00:00.000Z";
    for (const [name, store] of [
      ["sqlite", sqlite],
      ["tcvdb", tcvdb],
    ] as const) {
      const before = await store.countL1();
      const removed = await store.deleteL1Expired(cutoff);
      const after = await store.countL1();
      expect([name, DEGRADATIONS.ttlSafetyThreshold[name]]).toEqual([
        name,
        true,
      ]);
      expect([name, removed]).toEqual([name, 0]);
      expect([name, after]).toEqual([name, before]);
    }
  });

  it("a TTL sweep under the guard removes on both backends alike", async () => {
    // One old row among many fresh ones — well under 80%.
    for (const [name, store] of [
      ["sqlite", sqlite],
      ["tcvdb", tcvdb],
    ] as const) {
      await store.upsertL1(record(`${name}-old`, "2020-01-01T00:00:00.000Z"));
      const before = await store.countL1();
      const removed = await store.deleteL1Expired("2021-01-01T00:00:00.000Z");
      expect([name, removed]).toEqual([name, 1]);
      expect([name, await store.countL1()]).toEqual([name, before - 1]);
    }
  });
});

/**
 * tz-05 Ф4b/Ф6 — scope and provenance have to survive the round trip on BOTH
 * backends, and the check has to be able to fail. The store turns every error
 * into an empty array, so "read nothing" is the shape both a working empty
 * collection and a rejected filter take: every assertion below therefore pairs
 * a non-empty read-back with an empty rejection journal.
 */
describe("scope and provenance on both backends", () => {
  const OWN = "/repo/own";
  const OTHER = "/repo/other";
  const TEXT = "scoped provenance carrier sentinel";
  /** Only the three records this block seeded — earlier tests share the prefix. */
  const MINE = ["own", "other", "global"];
  const mine = (name: string, id: string): boolean =>
    MINE.some((k) => id === `${name}-${k}`);

  const CHAIN = {
    source: "user-input",
    createdAt: "2026-08-12T00:00:00.000Z",
    chain: [
      { role: "extractor", action: "store", at: "2026-08-12T00:00:00.000Z" },
    ],
  };

  function scoped(id: string, scope: string, projectId: string): MemoryRecord {
    return {
      ...record(id, "2026-08-12T00:00:00.000Z"),
      content: TEXT,
      scope,
      projectId,
      metadata: { _tdai_provenance: CHAIN },
    } as MemoryRecord;
  }

  beforeAll(async () => {
    for (const [name, store] of [
      ["sqlite", sqlite],
      ["tcvdb", tcvdb],
    ] as const) {
      await store.upsertL1(scoped(`${name}-own`, "project", OWN));
      await store.upsertL1(scoped(`${name}-other`, "project", OTHER));
      await store.upsertL1(scoped(`${name}-global`, "global", OTHER));
    }
  });

  it.each(bothBackends())(
    "%s round-trips scope, project_id and the chain",
    async (name, get) => {
      const hits = (
        await get().searchL1Fts("sentinel", 20, OWN, "hidden")
      ).filter((h) => mine(name, h.record_id));
      expect([name, fake.rejectedFilters]).toEqual([name, []]);
      expect([name, hits.length > 0]).toEqual([name, true]);
      const own = hits.find((h) => h.record_id === `${name}-own`);
      expect([name, own?.scope]).toEqual([name, "project"]);
      expect([name, own?.project_id]).toEqual([name, OWN]);
      expect([
        name,
        JSON.parse(own?.metadata_json ?? "{}")._tdai_provenance,
      ]).toEqual([name, CHAIN]);
    },
  );

  it.each(bothBackends())(
    "%s hides another project's record and keeps global",
    async (name, get) => {
      // Recall is the store filter THEN the JS predicate (search.ts), so the
      // parity that matters is of the pair: in `hidden` the TCVDB store
      // deliberately emits no filter, because a predicate over `scope` would
      // drop every document written before this package.
      const visible = (await get().searchL1Fts("sentinel", 20, OWN, "hidden"))
        .filter((h) => passesScope(h, OWN, "hidden"))
        .map((h) => h.record_id)
        .filter((id) => mine(name, id))
        .sort();
      expect([name, fake.rejectedFilters]).toEqual([name, []]);
      expect([name, visible]).toEqual([
        name,
        [`${name}-global`, `${name}-own`],
      ]);
    },
  );

  it.each(bothBackends())(
    "%s returns every project in decay mode",
    async (name, get) => {
      const visible = (await get().searchL1Fts("sentinel", 20, OWN, "decay"))
        .map((h) => h.record_id)
        .filter((id) => mine(name, id))
        .sort();
      expect([name, fake.rejectedFilters]).toEqual([name, []]);
      expect([name, visible]).toEqual([
        name,
        [`${name}-global`, `${name}-other`, `${name}-own`],
      ]);
    },
  );

  // The batch path is not a shortcut for the same write: it is the route the
  // sqlite→tcvdb migration takes, and the route migrate-scope.ts prescribes for
  // reaching strict on TCVDB at all. It used to build its own document literal,
  // which never learned about scope.
  it.each(bothBackends())(
    "%s writes the same attributes through the batch path",
    async (name, get) => {
      const store = get();
      const batched = scoped(`${name}-batch-own`, "project", OWN);
      const upsertBatch = (
        store as unknown as {
          upsertL1Batch?: (r: MemoryRecord[]) => Promise<number>;
        }
      ).upsertL1Batch;
      if (!upsertBatch) return; // sqlite has no batch API — nothing to diverge.
      expect([name, await upsertBatch.call(store, [batched])]).toEqual([
        name,
        1,
      ]);

      const strict = await store.searchL1Fts("sentinel", 20, OWN, "strict");
      const hit = strict.find((h) => h.record_id === `${name}-batch-own`);
      expect([name, fake.rejectedFilters]).toEqual([name, []]);
      // strict is the mode the migration exists to reach: a document the batch
      // wrote without scope would be invisible here.
      expect([name, hit?.scope]).toEqual([name, "project"]);
      expect([name, hit?.project_id]).toEqual([name, OWN]);
    },
  );
});

/**
 * A document written before tz-05 has no `scope` and no `project_id` at all.
 * TCVDB cannot express "field missing", so ANY predicate over those fields
 * drops such a document — which would make every pre-existing memory
 * unreachable the moment this package shipped. The default mode therefore
 * filters nothing store-side and leans on the JS predicate.
 */
describe("a document older than the scope attribute", () => {
  it("stays visible on TCVDB in the default mode", async () => {
    const legacyFake = await startTcvdbFake();
    const store = new TcvdbMemoryStore({
      url: legacyFake.url,
      username: "u",
      apiKey: "k",
      database: "legacydb",
      embeddingModel: "m",
      timeout: 5000,
    });
    await store.init();
    // Written through the raw API on purpose: the store's own upsert would
    // add the fields, and then there would be nothing to test.
    await request(`${legacyFake.url}/document/upsert`, {
      method: "POST",
      body: JSON.stringify({
        database: "legacydb",
        collection: "legacydb_l1_memories",
        documents: [
          { id: "old", text: "legacy record", type: "episodic", priority: 50 },
        ],
      }),
    });

    const hidden = await store.searchL1Fts("legacy", 10, "/repo/own", "hidden");
    expect(hidden.map((h) => h.record_id)).toEqual(["old"]);
    expect(passesScope(hidden[0]!, "/repo/own", "hidden")).toBe(true);
    // strict is the post-migration mode: dropping a record that still has no
    // attribute is exactly its job.
    const strict = await store.searchL1Fts("legacy", 10, "/repo/own", "strict");
    expect(strict).toEqual([]);
    expect(legacyFake.rejectedFilters).toEqual([]);

    store.close();
    await legacyFake.close();
  });
});
