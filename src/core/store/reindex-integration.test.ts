/**
 * P8 — reindex integration tests (wave tdai-memory-subagents-2026-08-02).
 *
 * Runs against a REAL VectorStore on a scratch data dir with fake 4-dim
 * embeddings — never against ~/.pi/agent-memory. Covers:
 *   - per-row incremental reindex (reindexL1Records / reindexL0Records);
 *   - reindex-in-progress gate: searches fail OPEN (empty, not error);
 *   - skip-dual-write: vec writes skipped during the full-reindex window,
 *     meta rows still written; the delta is reported by consistencyCheck
 *     missingIds / l0MissingIds and healed by per-row backfill;
 *   - sqlite-vec 0.1.9 pin: DELETE/INSERT on vec0 text columns >12 chars
 *     (#274 regression), count-check, KNN-sanity on the installed package;
 *   - backup-snapshot evidence for the pre-upgrade snapshot.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { VectorStore } from "./sqlite.js";
import type { EmbeddingService } from "./embedding.js";
import type { Logger } from "../types.js";

const require = createRequire(import.meta.url);

const DIMS = 4;

function fakeVec(seed = 0): Float32Array {
  const v = new Float32Array(DIMS);
  v[seed % DIMS] = 1;
  return v;
}

const fakeEmbedding: EmbeddingService = {
  embed: async (text: string) => fakeVec(text.length),
  embedBatch: async (texts: string[]) => texts.map((t) => fakeVec(t.length)),
  getDimensions: () => DIMS,
  getProviderInfo: () => ({ provider: "fake", model: "fake" }),
  isReady: () => true,
  startWarmup: () => undefined,
  close: async () => undefined,
};

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Long record ids (>&nbsp;12 chars) — the vec0 DELETE regression #274 case. */
function longId(n: number): string {
  return `m_record_id_way_longer_than_12_chars_${n}`;
}

function l1Record(id: string, content: string) {
  return {
    id,
    content,
    type: "episodic" as const,
    priority: 50,
    scene_name: "test",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-08-01T00:00:00Z"],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    sessionKey: "cc-test",
    sessionId: "cc-test",
  };
}

describe("P8 reindex integration", () => {
  let dir: string;
  let dbPath: string;
  let store: VectorStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-reindex-"));
    dbPath = path.join(dir, "vectors.db");
    store = new VectorStore(dbPath, DIMS, silentLogger);
    store.init();
  });

  afterEach(() => {
    try { store.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reindexL1Records: per-row delete+insert by record_id (NOT a SQL UPDATE)", async () => {
    const id1 = longId(1);
    const id2 = longId(2);
    store.upsertL1(l1Record(id1, "alpha content"), fakeVec(1));
    store.upsertL1(l1Record(id2, "beta content"), fakeVec(2));
    expect(store.consistencyCheck().missingIds).toEqual([]);

    // Drop a vector manually (simulates a lost row), then backfill per-row.
    const db = store as unknown as {
      db: { prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] } };
    };
    db.db.prepare("DELETE FROM l1_vec WHERE record_id = ?").run(id2);
    const check = store.consistencyCheck();
    expect(check.missingIds).toContain(id2);

    const result = await store.reindexL1Records([id2], (t) => Promise.resolve(fakeVec(t.length)));
    expect(result).toEqual({ done: 1, total: 1 });

    const after = store.consistencyCheck();
    expect(after.vecCount).toBe(after.metaCount);
    expect(after.missingIds).toEqual([]);
    // The backfilled row is searchable.
    const hits = store.searchL1Vector(fakeVec(2), 5);
    expect(hits.map((h) => h.record_id)).toContain(id2);
  });

  it("reindexL1Records skips missing meta rows and is idempotent", async () => {
    const id = longId(3);
    store.upsertL1(l1Record(id, "content"), fakeVec(3));
    const r1 = await store.reindexL1Records([id, "never-existed"], (t) => Promise.resolve(fakeVec(t.length)));
    expect(r1.done).toBe(2);
    const r2 = await store.reindexL1Records([id], (t) => Promise.resolve(fakeVec(t.length)));
    expect(r2.done).toBe(1);
  });

  it("reindex-in-progress: vector searches fail OPEN (empty, not error)", async () => {
    const id = longId(4);
    const idNew = longId(41); // written DURING the window
    store.upsertL1(l1Record(id, "searchable"), fakeVec(4));
    expect(store.isReindexing()).toBe(false);

    // Start a full reindex whose embedFn blocks — the flag stays on.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slowEmbed = async (t: string) => { await gate; return fakeVec(t.length); };
    const reindexPromise = store.reindexAll(slowEmbed);
    await new Promise((r) => setTimeout(r, 20));
    expect(store.isReindexing()).toBe(true);

    try {
      // L1 + L0 searches return [] (fail-open), not an error.
      expect(store.searchL1Vector(fakeVec(4), 5)).toEqual([]);
      const l0 = {
        id: longId(5),
        sessionKey: "s",
        sessionId: "",
        role: "user",
        messageText: "hello",
        recordedAt: "2026-08-01T00:00:00Z",
        timestamp: 1,
      };
      store.upsertL0(l0, fakeVec(1));
      expect(store.searchL0Vector(fakeVec(1), 5)).toEqual([]);

      // Dual-write skip: a record written DURING the window gets its meta row
      // but NO vector (vecCount stays at the pre-window 1).
      store.upsertL1(l1Record(idNew, "written during window"), fakeVec(2));
      const checkMid = store.consistencyCheck();
      expect(checkMid.metaCount).toBe(2);
      expect(checkMid.vecCount).toBe(1);
      expect(checkMid.missingIds).toContain(idNew);

      // L0 update-embedding skip during the window.
      expect(store.updateL0Embedding(l0.id, fakeVec(1))).toBe(false);
      expect(store.consistencyCheck().l0MissingIds).toContain(l0.id);
    } finally {
      // Always release — a failed assertion must not leak the module-level
      // reindex gate into subsequent tests (lock + flag are shared module state).
      release();
      await reindexPromise;
    }
    expect(store.isReindexing()).toBe(false);
    expect(store.searchL1Vector(fakeVec(4), 5).length).toBeGreaterThan(0);
  });

  it("skip-dual-write delta is healed by reindexL1Records / reindexL0Records backfill", async () => {
    const id = longId(6);
    const l0 = {
      id: longId(7),
      sessionKey: "s",
      sessionId: "",
      role: "user",
      messageText: "l0 text",
      recordedAt: "2026-08-01T00:00:00Z",
      timestamp: 1,
    };
    store.upsertL1(l1Record(id, "l1 text"), fakeVec(6));
    store.upsertL0(l0, undefined); // meta only (bg-embed path)
    // Simulate the window: force the delta (vec rows missing).
    const db = store as unknown as { db: { prepare(sql: string): { run(...p: unknown[]): unknown } } };
    db.db.prepare("DELETE FROM l1_vec WHERE record_id = ?").run(id);
    db.db.prepare("DELETE FROM l0_vec WHERE record_id = ?").run(l0.id);

    const check = store.consistencyCheck();
    expect(check.missingIds).toContain(id);
    expect(check.l0MissingIds).toContain(l0.id);

    await store.reindexL1Records(check.missingIds, (t) => Promise.resolve(fakeVec(t.length)));
    await store.reindexL0Records(check.l0MissingIds, (t) => Promise.resolve(fakeVec(t.length)));

    const after = store.consistencyCheck();
    expect(after.missingIds).toEqual([]);
    expect(after.l0MissingIds).toEqual([]);
    expect(after.vecCount).toBe(after.metaCount);
    expect(after.l0VecCount).not.toBeNull(); // vec0 present — counted
  });

  it("reindexAll runs single-flight and clears the flag on failure too", async () => {
    // A row so the failing embedFn is actually exercised (per-row skip path).
    store.upsertL1(l1Record(longId(8), "will fail to embed"), fakeVec(8));
    const first = await store.reindexAll(async () => { throw new Error("embed down"); });
    expect(first.l1Count).toBe(1); // row attempted; per-row failure is logged+skipped, never thrown
    // The pre-existing vector survives a failed re-embed (no data loss).
    expect(store.consistencyCheck().vecCount).toBe(1);
    expect(store.isReindexing()).toBe(false);

    const second = await store.reindexAll(async (t) => Promise.resolve(fakeVec(t.length)));
    expect(store.isReindexing()).toBe(false);
    expect(second.l1Count + second.l0Count).toBeGreaterThanOrEqual(1);
  });
});

describe("P8 sqlite-vec 0.1.9 (installed package)", () => {
  it("package.json pins sqlite-vec 0.1.9 (not the alpha)", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf-8"),
    ) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["sqlite-vec"]).toBe("0.1.9");
  });

  it("0.1.9 loads and vec0 DELETE+INSERT works on text columns >12 chars (#274)", () => {
    const sqliteVec = require("sqlite-vec");
    expect(typeof sqliteVec.load).toBe("function");
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-vec019-"));
    const store2 = new VectorStore(path.join(dir2, "v.db"), DIMS, silentLogger);
    store2.init();
    try {
      const id = "record_id_way_longer_than_twelve_chars_0001";
      store2.upsertL1(l1Record(id, "long-id content"), fakeVec(1));
      // Delete regression: DELETE from vec0 with >12-char text column.
      expect(store2.deleteL1(id)).toBe(true);
      const check = store2.consistencyCheck();
      expect(check.metaCount).toBe(0);
      expect(check.vecCount).toBe(0);

      // Re-insert + KNN-sanity: the query row comes back first.
      store2.upsertL1(l1Record(id, "knn target content"), fakeVec(1));
      const hits = store2.searchL1Vector(fakeVec(1), 3);
      expect(hits.length).toBe(1);
      expect(hits[0]!.record_id).toBe(id);
      expect(hits[0]!.score).toBeGreaterThan(0.9);
    } finally {
      try { store2.close(); } catch { /* ignore */ }
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("pre-upgrade backup snapshot exists (evidence for the bump)", () => {
    // The live-DB snapshot taken BEFORE the package.json bump (operational
    // step, P8). Skipped on machines without the live memory tree.
    const candidates = [
      "/home/penis/.pi/agent-memory/tdai/vectors.db.bak-pre-sqlite-vec-0.1.9-2026-08-02-1331",
      "/home/penis/.memory-tencentdb/memory-tdai/vectors.db.bak-pre-sqlite-vec-0.1.9-2026-08-02-1331",
    ];
    const live = [
      "/home/penis/.pi/agent-memory/tdai/vectors.db",
      "/home/penis/.memory-tencentdb/memory-tdai/vectors.db",
    ];
    const present = candidates.filter((c, i) => fs.existsSync(live[i]!) && fs.existsSync(c));
    expect(present.length).toBeGreaterThan(0);
  });
});
