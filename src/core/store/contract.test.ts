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
import type { IMemoryStore } from "./types.js";
import type { MemoryRecord } from "../record/l1-writer.js";

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
