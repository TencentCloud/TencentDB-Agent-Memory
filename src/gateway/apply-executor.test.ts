/**
 * P4 — ApplyExecutor unit tests (wave tdai-memory-subagents-2026-08-02).
 *
 * Runs against a REAL SqliteMemoryStore (VectorStore) on a scratch data dir
 * with fake 4-dim embeddings — never against ~/.pi/agent-memory. Covers
 * criteria 19a/19c/19i + count check on fake vectors + heal re-run.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import type http from "node:http";
import { createRequire } from "node:module";
import { VectorStore } from "../core/store/sqlite.js";
import type { MemoryRecord } from "../core/record/l1-writer.js";
import type { EmbeddingService } from "../core/store/embedding.js";
import type { IMemoryStore } from "../core/store/types.js";
import type { Logger } from "../core/types.js";
import {
  ApplyExecutor,
  handleMemoryApply,
  SCENE_LIMIT_CHARS,
  PERSONA_LIMIT_CHARS,
  MAX_REINDEX_RETRIES,
} from "./apply-executor.js";
import type { GatewayConfig } from "./config.js";

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const require = createRequire(import.meta.url);

vi.mock("../core/record/l1-writer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/record/l1-writer.js")>();
  return { ...actual, writeMemory: vi.fn(actual.writeMemory) };
});

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

/** Collecting logger for assertions. */
function collectingLogger(): { logger: Logger; warns: string[]; infos: string[] } {
  const warns: string[] = [];
  const infos: string[] = [];
  return {
    warns,
    infos,
    logger: {
      debug: () => undefined,
      info: (m: string) => infos.push(m),
      warn: (m: string) => warns.push(m),
      error: (m: string) => undefined,
    },
  };
}

const META_BLOCK = [
  "-----META-START-----",
  "created: 2026-08-02T00:00:00Z",
  "updated: 2026-08-02T00:00:00Z",
  "summary: test block",
  "heat: 1",
  "-----META-END-----",
].join("\n");

const SCENE_CONTENT = `${META_BLOCK}\n\nscene body`;

function mem(id: string, content: string, updatedAt = "2026-08-01T00:00:00Z"): MemoryRecord {
  return {
    id,
    content,
    type: "episodic",
    priority: 50,
    scene_name: "test",
    source_message_ids: [],
    metadata: {},
    timestamps: [updatedAt],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt,
    sessionKey: "cc-test",
    sessionId: "cc-test",
    projectId: "",
    scope: "global",
  };
}

/** Writable SQLite helper (node:sqlite under Node, bun:sqlite under Bun). */
function openWritable(dbPath: string): { exec(sql: string): void; prepare(sql: string): { run(...p: unknown[]): void; get(...p: unknown[]): unknown }; close(): void } {
  if ((globalThis as { Bun?: unknown }).Bun !== undefined) {
    const { Database } = require("bun:sqlite") as { Database: new (p: string) => unknown };
    return new Database(dbPath) as never;
  }
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (p: string) => unknown };
  return new DatabaseSync(dbPath) as never;
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath, "utf-8")).digest("hex");
}

/** Build a baseline manifest from existing files. */
function baseline(dataDir: string, relPaths: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of relPaths) out[p] = sha256File(path.join(dataDir, p));
  return out;
}

/** Build a valid apply request body. */
function body(
  diff: Record<string, unknown>,
  baselineMap: Record<string, string> = {},
  presented: string[] = [],
): unknown {
  return { diff, manifest: { baseline: baselineMap }, context: { presentedRecordIds: presented } };
}

const EMPTY_DIFF = body({}, {}, []);

describe("ApplyExecutor", () => {
  let dir: string;
  let dataDir: string;
  let store: VectorStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-apply-"));
    dataDir = path.join(dir, "tdai");
    fs.mkdirSync(path.join(dataDir, "scene_blocks", "_global"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, ".metadata"), { recursive: true });
    store = new VectorStore(path.join(dataDir, "vectors.db"), DIMS, silentLogger);
    store.init();
  });

  afterEach(async () => {
    try { store.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function executor(overrides: Partial<{ vectorStore: IMemoryStore | undefined; embeddingService: EmbeddingService | undefined }> = {}): ApplyExecutor {
    return new ApplyExecutor({
      dataDir,
      logger: silentLogger,
      vectorStore: overrides.vectorStore ?? store,
      embeddingService: overrides.embeddingService ?? fakeEmbedding,
    });
  }

  function seedRecord(id: string, content: string, updatedAt?: string): void {
    store.upsertL1(mem(id, content, updatedAt), fakeVec(id.length));
  }

  // ============================
  // 19c — invalid diff → abort, no partial
  // ============================

  it("garbage body → aborted 400, nothing applied", async () => {
    const r = await executor().apply({ not: "a diff" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("aborted");
    expect(r.statusCode).toBe(400);
    expect(r.partial).toBe(false);
    expect(r.applied).toEqual({ merges: [], deletes: [], rewrites: [] });
    expect(r.error).toMatch(/Invalid apply request/);
  });

  it("deleteL1 id not presented to the keeper → 400, nothing applied", async () => {
    seedRecord("m_x", "some memory");
    const r = await executor().apply(
      body({ deleteL1: [{ id: "m_x", updatedAt: "2026-08-01T00:00:00Z" }] }, {}, []),
    );
    expect(r.statusCode).toBe(400);
    expect(r.partial).toBe(false);
    expect(r.error).toMatch(/not presented/);
    // record untouched
    expect(store.countL1()).toBe(1);
  });

  it("merge target outside its cluster → 400", async () => {
    seedRecord("m_a", "a");
    seedRecord("m_b", "b");
    const r = await executor().apply(
      body({ merge: [{ cluster: ["m_a", "m_b"], target: "m_zzz", content: "merged" }] }, {}, ["m_a", "m_b"]),
    );
    expect(r.statusCode).toBe(400);
    expect(r.partial).toBe(false);
    expect(r.error).toMatch(/not a member/);
  });

  it("merge cluster member not presented to the keeper → 400", async () => {
    seedRecord("m_a", "a");
    seedRecord("m_b", "b");
    const r = await executor().apply(
      body({ merge: [{ cluster: ["m_a", "m_b"], target: "m_a", content: "merged" }] }, {}, ["m_a"]),
    );
    expect(r.statusCode).toBe(400);
    expect(r.partial).toBe(false);
    expect(r.error).toMatch(/was not presented/);
  });

  it("rewriteBlock path outside allowlist → 400", async () => {
    const r = await executor().apply(
      body({ rewriteBlock: [{ path: "../../etc/passwd", content: SCENE_CONTENT }] }, {}, []),
    );
    expect(r.statusCode).toBe(400);
    expect(r.partial).toBe(false);
    expect(r.error).toMatch(/allowlist/);
  });

  it("rewriteBlock content without META delimiters → 400 before any mutation", async () => {
    const scenePath = "scene_blocks/_global/ok.md";
    fs.writeFileSync(path.join(dataDir, scenePath), SCENE_CONTENT, "utf-8");
    const r = await executor().apply(
      body({ rewriteBlock: [{ path: scenePath, content: "body without meta" }] }, baseline(dataDir, [scenePath]), []),
    );
    expect(r.statusCode).toBe(400);
    expect(r.partial).toBe(false);
    expect(r.error).toMatch(/META/);
    // file untouched
    expect(fs.readFileSync(path.join(dataDir, scenePath), "utf-8")).toBe(SCENE_CONTENT);
  });

  it("rewriteBlock content over the scene limit → 400 (zod)", async () => {
    const scenePath = "scene_blocks/_global/ok.md";
    fs.writeFileSync(path.join(dataDir, scenePath), SCENE_CONTENT, "utf-8");
    const over = `${META_BLOCK}\n\n${"x".repeat(SCENE_LIMIT_CHARS + 10)}`;
    const r = await executor().apply(
      body({ rewriteBlock: [{ path: scenePath, content: over }] }, baseline(dataDir, [scenePath]), []),
    );
    expect(r.statusCode).toBe(400);
    expect(r.partial).toBe(false);
  });

  it("rewritePersona over the persona limit → 400 (zod)", async () => {
    fs.writeFileSync(path.join(dataDir, "persona.md"), "persona", "utf-8");
    const r = await executor().apply(
      body({ rewritePersona: "y".repeat(PERSONA_LIMIT_CHARS + 5) }, baseline(dataDir, ["persona.md"]), []),
    );
    expect(r.statusCode).toBe(400);
    expect(r.partial).toBe(false);
  });

  it("rewriteBlock path not covered by the manifest baseline → 400", async () => {
    const r = await executor().apply(
      body({ rewriteBlock: [{ path: "scene_blocks/_global/ok.md", content: SCENE_CONTENT }] }, {}, []),
    );
    expect(r.statusCode).toBe(400);
    expect(r.error).toMatch(/not covered by the manifest/);
  });

  // ============================
  // 19c — runtime failure: deleteL1Batch=false → abort, NOT partial
  // ============================

  it("deleteL1Batch=false → aborted 500, nothing applied, record intact", async () => {
    seedRecord("m_del", "doomed", "2026-08-01T00:00:00Z");
    const failingStore = {
      deleteL1Batch: async () => false,
      consistencyCheck: async () => ({ metaCount: 1, vecCount: 1, orphanIds: [] }),
    } as unknown as IMemoryStore;
    const r = await executor({ vectorStore: failingStore }).apply(
      body({ deleteL1: [{ id: "m_del", updatedAt: "2026-08-01T00:00:00Z" }] }, {}, ["m_del"]),
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe("aborted");
    expect(r.statusCode).toBe(500);
    expect(r.partial).toBe(false);
    expect(r.error).toMatch(/deleteL1Batch failed/);
    expect(store.countL1()).toBe(1); // fresh data not lost
  });

  // ============================
  // 19c — runtime failure: writeMemory → null → abort, NOT partial
  // ============================

  it("writeMemory null → aborted 500, nothing applied", async () => {
    seedRecord("m_a", "a", "2026-08-01T00:00:00Z");
    seedRecord("m_b", "b", "2026-08-01T00:00:00Z");
    const { writeMemory } = await import("../core/record/l1-writer.js");
    const mock = writeMemory as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce(null);
    try {
      const r = await executor().apply(
        body({ merge: [{ cluster: ["m_a", "m_b"], target: "m_a", content: "merged" }] }, {}, ["m_a", "m_b"]),
      );
      expect(r.statusCode).toBe(500);
      expect(r.partial).toBe(false);
      expect(r.error).toMatch(/writeMemory returned null/);
      // m_b was not removed (abort before deleteL1Batch)
      expect(store.countL1()).toBe(2);
    } finally {
      mock.mockClear();
    }
  });

  // ============================
  // 19c — stale delete: drifted updatedAt → abort, fresh data kept
  // ============================

  it("stale delete (updatedAt drift) → aborted 409, record intact", async () => {
    seedRecord("m_fresh", "fresh content", "2026-08-01T00:00:00Z");
    const r = await executor().apply(
      body({ deleteL1: [{ id: "m_fresh", updatedAt: "2026-07-01T00:00:00Z" }] }, {}, ["m_fresh"]),
    );
    expect(r.statusCode).toBe(409);
    expect(r.partial).toBe(false);
    expect(r.error).toMatch(/updated since the diff/);
    expect(store.countL1()).toBe(1);
    const rows = await store.queryL1Records();
    expect(rows[0]?.content).toBe("fresh content");
  });

  // ============================
  // 19i — heal re-run skips already-applied ops
  // ============================

  it("heal: abort on 2nd mutation, re-run skips applied and completes the rest", async () => {
    seedRecord("m_a", "alpha", "2026-08-01T00:00:00Z");
    seedRecord("m_b", "beta", "2026-08-01T00:00:00Z");
    seedRecord("m_c", "gamma", "2026-08-01T00:00:00Z");
    fs.writeFileSync(path.join(dataDir, "persona.md"), "old persona", "utf-8");
    const manifest = baseline(dataDir, ["persona.md"]);

    const diff = {
      merge: [{ cluster: ["m_a", "m_b"], target: "m_a", content: "merged AB" }],
      // drifted updatedAt → run 1 aborts here, AFTER the merge was applied
      deleteL1: [{ id: "m_c", updatedAt: "2026-07-01T00:00:00Z" }],
      rewritePersona: "new persona",
    };

    // Run 1: merge applied, delete stale-aborts → partial.
    const r1 = await executor().apply(body(diff, manifest, ["m_a", "m_b", "m_c"]));
    expect(r1.status).toBe("aborted");
    expect(r1.partial).toBe(true);
    expect(r1.applied.merges).toEqual(["m_a"]);
    expect(r1.statusCode).toBe(409);

    // Between runs: the drifted record disappears (e.g. concurrent process).
    store.deleteL1("m_c");

    // Run 2: merge skipped (members gone), delete skipped (target missing),
    // persona rewritten → applied.
    const r2 = await executor().apply(body(diff, manifest, ["m_a", "m_b", "m_c"]));
    expect(r2.ok).toBe(true);
    expect(r2.status).toBe("applied");
    expect(r2.skipped.merges).toEqual(["m_a"]);
    expect(r2.skipped.deletes).toEqual(["m_c"]);
    expect(r2.applied.rewrites).toEqual(["persona.md"]);
    expect(fs.readFileSync(path.join(dataDir, "persona.md"), "utf-8")).toBe("new persona");
  });

  // ============================
  // 19a — trust-boundary: manifest drift → abort (negative write path)
  // ============================

  it("manifest drift (file touched outside apply) → aborted 409, nothing applied", async () => {
    const scenePath = "scene_blocks/_global/ok.md";
    fs.writeFileSync(path.join(dataDir, scenePath), SCENE_CONTENT, "utf-8");
    const manifest = baseline(dataDir, [scenePath]);
    // concurrent writer touches the file after baseline
    fs.writeFileSync(path.join(dataDir, scenePath), SCENE_CONTENT + "\ndrifted", "utf-8");

    const newContent = `${META_BLOCK}\n\nrewritten body`;
    const r = await executor().apply(
      body({ rewriteBlock: [{ path: scenePath, content: newContent }] }, manifest, []),
    );
    expect(r.statusCode).toBe(409);
    expect(r.partial).toBe(false);
    expect(r.error).toMatch(/manifest drift/);
    expect(fs.readFileSync(path.join(dataDir, scenePath), "utf-8")).toContain("drifted");
  });

  it("manifest drift tolerated when content already equals the diff rewrite (heal)", async () => {
    const scenePath = "scene_blocks/_global/ok.md";
    fs.writeFileSync(path.join(dataDir, scenePath), SCENE_CONTENT, "utf-8");
    const manifest = baseline(dataDir, [scenePath]);
    const newContent = `${META_BLOCK}\n\nrewritten by previous apply`;
    // a previous apply already wrote the target content
    fs.writeFileSync(path.join(dataDir, scenePath), newContent, "utf-8");

    const r = await executor().apply(
      body({ rewriteBlock: [{ path: scenePath, content: newContent }] }, manifest, []),
    );
    expect(r.ok).toBe(true);
    expect(r.skipped.rewrites).toEqual([scenePath]); // already applied → skip
  });

  // ============================
  // delete pre-check: missing target → skip (idempotent re-run)
  // ============================

  it("delete of an already-missing record → skipped, not aborted", async () => {
    const r = await executor().apply(
      body({ deleteL1: [{ id: "ghost", updatedAt: "2026-08-01T00:00:00Z" }] }, {}, ["ghost"]),
    );
    expect(r.ok).toBe(true);
    expect(r.skipped.deletes).toEqual(["ghost"]);
    expect(r.applied.deletes).toEqual([]);
  });

  // ============================
  // merge happy path
  // ============================

  it("merge: members removed, target carries merged content, vec-vs-meta consistent", async () => {
    seedRecord("m_a", "alpha", "2026-08-01T00:00:00Z");
    seedRecord("m_b", "beta", "2026-08-01T00:00:00Z");
    const r = await executor().apply(
      body({ merge: [{ cluster: ["m_a", "m_b"], target: "m_a", content: "merged content" }] }, {}, ["m_a", "m_b"]),
    );
    expect(r.ok).toBe(true);
    expect(r.applied.merges).toEqual(["m_a"]);

    const rows = await store.queryL1Records();
    expect(rows.length).toBe(1);
    expect(rows[0]?.record_id).toBe("m_a");
    expect(rows[0]?.content).toBe("merged content");

    const check = store.consistencyCheck();
    expect(check.metaCount).toBe(1);
    expect(check.vecCount).toBe(1);
    expect(check.orphanIds).toEqual([]);
  });

  // ============================
  // criterion 5 — dedup does NOT trigger a full reindex (deleteL1Batch
  // dual-writes the vector, so vec-vs-meta stays consistent)
  // ============================

  it("criterion 5 — dedup via deleteL1 does NOT trigger a full reindex", async () => {
    seedRecord("d_1", "dup one", "2026-08-01T00:00:00Z");
    seedRecord("d_2", "dup two", "2026-08-01T00:00:00Z");
    expect(store.consistencyCheck().metaCount).toBe(2);
    expect(store.consistencyCheck().vecCount).toBe(2);

    const reindexAll = vi.spyOn(store, "reindexAll");
    const r = await executor().apply(
      body({ deleteL1: [{ id: "d_2", updatedAt: "2026-08-01T00:00:00Z" }] }, {}, ["d_2"]),
    );

    expect(r.ok).toBe(true);
    expect(r.applied.deletes).toEqual(["d_2"]);
    // Dual-write keeps vec-vs-meta consistent → no needsReindex, no reindexAll.
    const check = store.consistencyCheck();
    expect(check.metaCount).toBe(1);
    expect(check.vecCount).toBe(1);
    expect(check.orphanIds).toEqual([]);
    expect(r.reindexed).toBe(false);
    expect(r.needsReindex).toBe(false);
    expect(reindexAll).not.toHaveBeenCalled();
  });

  // ============================
  // criterion 3 — after apply, scene/persona files on disk respect the
  // mechanical limits (scene 1500 / persona 2000, acceptance-level)
  // ============================

  it("criterion 3 — after apply, scene/persona files on disk are within limits", async () => {
    const scenePath = "scene_blocks/_global/big.md";
    fs.writeFileSync(path.join(dataDir, scenePath), SCENE_CONTENT, "utf-8");
    fs.writeFileSync(path.join(dataDir, "persona.md"), "old persona body", "utf-8");
    const manifest = baseline(dataDir, [scenePath, "persona.md"]);

    const sceneBody = "x".repeat(SCENE_LIMIT_CHARS - META_BLOCK.length - 2);
    const newScene = `${META_BLOCK}\n\n${sceneBody}`;
    expect(newScene.length).toBe(SCENE_LIMIT_CHARS);
    const newPersona = "p".repeat(PERSONA_LIMIT_CHARS - 1);

    const r = await executor().apply(
      body(
        { rewriteBlock: [{ path: scenePath, content: newScene }], rewritePersona: newPersona },
        manifest,
        [],
      ),
    );
    expect(r.ok).toBe(true);

    const onDiskScene = fs.readFileSync(path.join(dataDir, scenePath), "utf-8");
    const onDiskPersona = fs.readFileSync(path.join(dataDir, "persona.md"), "utf-8");
    expect(onDiskScene.length).toBeLessThanOrEqual(SCENE_LIMIT_CHARS);
    expect(onDiskPersona.length).toBeLessThanOrEqual(PERSONA_LIMIT_CHARS);
    expect(onDiskPersona.length).toBe(PERSONA_LIMIT_CHARS - 1);
    expect(r.applied.rewrites).toContain(scenePath);
    expect(r.applied.rewrites).toContain("persona.md");
  });

  // ============================
  // count check on fake vectors: orphan purge
  // ============================

  it("count check: orphan vector purged, run succeeds without reindex", async () => {
    seedRecord("m_1", "one", "2026-08-01T00:00:00Z");
    seedRecord("m_2", "two", "2026-08-01T00:00:00Z");
    expect(store.consistencyCheck().metaCount).toBe(2);
    expect(store.consistencyCheck().vecCount).toBe(2);

    // Simulate a stray vec: remove m_2's meta row directly (bypasses store).
    const db = openWritable(path.join(dataDir, "vectors.db"));
    try {
      db.prepare("DELETE FROM l1_records WHERE record_id = ?").run("m_2");
    } finally {
      db.close();
    }
    let check = store.consistencyCheck();
    expect(check.metaCount).toBe(1);
    expect(check.vecCount).toBe(2);
    expect(check.orphanIds).toEqual(["m_2"]);

    // Empty apply → post-apply count check purges the orphan.
    const r = await executor().apply(EMPTY_DIFF);
    expect(r.ok).toBe(true);
    expect(r.counts).toEqual({ metaCount: 1, vecCount: 1, consistent: true });
    expect(r.reindexed).toBe(false);
    expect(r.needsReindex).toBe(false);
    check = store.consistencyCheck();
    expect(check.orphanIds).toEqual([]);
  });

  it("count check skipped when vec tables are absent (vecCount null), no reindex", async () => {
    const stub = {
      consistencyCheck: async () => ({ metaCount: 1, vecCount: null, orphanIds: [] }),
    } as unknown as IMemoryStore;
    const r = await executor({ vectorStore: stub }).apply(EMPTY_DIFF);
    expect(r.ok).toBe(true);
    expect(r.counts?.consistent).toBeNull();
    expect(r.reindexed).toBe(false);
    expect(r.needsReindex).toBe(false);
  });

  // ============================
  // P8 livelock cap (ТЗ §5.6): persistent count-mismatch → 2 reindexAll
  // retries, then per-row delta backfill (reindexL1Records) — never a 3rd
  // full reindex.
  // ============================

  it("livelock cap: persistent mismatch survives 2 reindexAll retries, per-row backfill resolves", async () => {
    const reindexAllCalls: number[] = [];
    const backfilled: string[][] = [];
    let fixed = false;
    const stub = {
      // reindexAll keeps failing (skip-dual-write delta persists) until the
      // per-row backfill repairs the missing rows.
      consistencyCheck: async () =>
        fixed
          ? { metaCount: 2, vecCount: 2, orphanIds: [], missingIds: [] }
          : { metaCount: 2, vecCount: 3, orphanIds: [], missingIds: ["m_delta"] },
      reindexAll: async () => { reindexAllCalls.push(1); return { l1Count: 0, l0Count: 0 }; },
      reindexL1Records: async (ids: string[]) => {
        backfilled.push(ids);
        fixed = true;
        return { done: ids.length, total: ids.length };
      },
      reindexL0Records: async () => { throw new Error("L0 heal must not run when L1 resolved"); },
    } as unknown as IMemoryStore;

    const r = await executor({ vectorStore: stub }).apply(EMPTY_DIFF);

    // Retry cap: exactly MAX_REINDEX_RETRIES full reindexes — no 3rd attempt.
    expect(reindexAllCalls.length).toBe(MAX_REINDEX_RETRIES);
    // Then the delta is backfilled per-row (reindexL1Records), not re-full-reindexed.
    expect(backfilled).toEqual([["m_delta"]]);
    expect(r.ok).toBe(true);
    expect(r.status).toBe("applied");
    expect(r.counts).toEqual({ metaCount: 2, vecCount: 2, consistent: true });
    expect(r.reindexed).toBe(true);
    expect(r.needsReindex).toBe(false);
  });

  it("livelock cap: backfill also unresolved → run failed, cap documented in the error", async () => {
    const reindexAllCalls: number[] = [];
    const backfilled: string[][] = [];
    const stub = {
      // Truly persistent mismatch — reindexAll AND per-row backfill cannot fix.
      consistencyCheck: async () => ({ metaCount: 2, vecCount: 3, orphanIds: [], missingIds: ["m_delta"] }),
      reindexAll: async () => { reindexAllCalls.push(1); return { l1Count: 0, l0Count: 0 }; },
      reindexL1Records: async (ids: string[]) => { backfilled.push(ids); return { done: ids.length, total: ids.length }; },
    } as unknown as IMemoryStore;

    const r = await executor({ vectorStore: stub }).apply(EMPTY_DIFF);

    expect(reindexAllCalls.length).toBe(MAX_REINDEX_RETRIES);
    expect(backfilled).toEqual([["m_delta"]]);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("failed");
    expect(r.needsReindex).toBe(true);
    expect(r.error).toMatch(
      new RegExp(`unresolved after ${MAX_REINDEX_RETRIES} reindex attempt\\(s\\) \\+ per-row backfill`),
    );
  });

  // ============================
  // rewriteBlock: atomic write + backup + syncSceneIndex
  // ============================

  it("rewriteBlock: atomic content write, backup created, scene index rebuilt", async () => {
    const scenePath = "scene_blocks/_global/ok.md";
    fs.writeFileSync(path.join(dataDir, scenePath), SCENE_CONTENT, "utf-8");
    const manifest = baseline(dataDir, [scenePath]);
    const newContent = `${META_BLOCK.replace("updated: 2026-08-02T00:00:00Z", "updated: 2026-08-03T00:00:00Z")}\n\nrewritten body`;

    const r = await executor().apply(body({ rewriteBlock: [{ path: scenePath, content: newContent }] }, manifest, []));
    expect(r.ok).toBe(true);
    expect(r.applied.rewrites).toEqual([scenePath]);
    expect(r.sceneIndexSynced).toBe(true);

    // content applied
    expect(fs.readFileSync(path.join(dataDir, scenePath), "utf-8")).toBe(newContent);
    // backup of the old content exists
    const backupDir = path.join(dataDir, ".backup");
    const backups = fs.readdirSync(backupDir).filter((f) => f.startsWith("apply-") && f.endsWith(".bak"));
    expect(backups.length).toBe(1);
    expect(fs.readFileSync(path.join(backupDir, backups[0]!), "utf-8")).toBe(SCENE_CONTENT);
    // scene index rebuilt from the new file
    const index = JSON.parse(fs.readFileSync(path.join(dataDir, ".metadata", "scene_index", "_global.json"), "utf-8"));
    expect(index).toHaveLength(1);
    expect(index[0].summary).toBe("test block");
  });

  it("syncSceneIndex failure → run failed (files stay applied, heal possible)", async () => {
    const scenePath = "scene_blocks/_global/ok.md";
    fs.writeFileSync(path.join(dataDir, scenePath), SCENE_CONTENT, "utf-8");
    // .metadata/scene_index is a FILE → mkdir fails inside syncSceneIndex
    fs.writeFileSync(path.join(dataDir, ".metadata", "scene_index"), "not a dir", "utf-8");
    const manifest = baseline(dataDir, [scenePath]);
    const newContent = `${META_BLOCK}\n\nrewritten body`;

    const r = await executor().apply(body({ rewriteBlock: [{ path: scenePath, content: newContent }] }, manifest, []));
    expect(r.ok).toBe(false);
    expect(r.status).toBe("failed");
    expect(r.sceneIndexSynced).toBe(false);
    expect(r.applied.rewrites).toEqual([scenePath]);
    expect(r.error).toMatch(/syncSceneIndex failed/);
    // re-run with the same diff: the file rewrite is skipped (content matches),
    // only the sync failure remains → still failed, but no mutation repeats.
    const r2 = await executor().apply(body({ rewriteBlock: [{ path: scenePath, content: newContent }] }, manifest, []));
    expect(r2.status).toBe("failed");
    expect(r2.skipped.rewrites).toEqual([scenePath]);
    // once the index path is fixed (validate/cleanup), the same diff applies cleanly
    fs.rmSync(path.join(dataDir, ".metadata", "scene_index"));
    const r3 = await executor().apply(body({ rewriteBlock: [{ path: scenePath, content: newContent }] }, manifest, []));
    expect(r3.ok).toBe(true);
    expect(r3.applied.rewrites).toEqual([]);
  });
});

// ============================
// HTTP handler (Content-Type gate, criterion 20)
// ============================

describe("handleMemoryApply (HTTP)", () => {
  let dir: string;
  let dataDir: string;
  let store: VectorStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-apply-http-"));
    dataDir = path.join(dir, "tdai");
    fs.mkdirSync(path.join(dataDir, "scene_blocks", "_global"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, ".metadata"), { recursive: true });
    store = new VectorStore(path.join(dataDir, "vectors.db"), DIMS, silentLogger);
    store.init();
  });

  afterEach(async () => {
    try { store.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeReq(bodyText: string, contentType = "application/json"): http.IncomingMessage {
    const req = new EventEmitter() as unknown as http.IncomingMessage;
    (req as { headers: Record<string, string> }).headers = { "content-type": contentType };
    queueMicrotask(() => {
      req.emit("data", Buffer.from(bodyText, "utf-8"));
      req.emit("end");
    });
    return req;
  }

  function resStub(): { res: http.ServerResponse; status: () => number | undefined; body: () => unknown } {
    let status: number | undefined;
    let bodyText = "";
    const res = {
      writeHead: (code: number) => { status = code; },
      end: (body?: unknown) => { bodyText = typeof body === "string" ? body : ""; },
    } as unknown as http.ServerResponse;
    return {
      res,
      status: () => status,
      body: () => (bodyText ? JSON.parse(bodyText) : null),
    };
  }

  function ctx(): { core: { getVectorStore: () => IMemoryStore; getEmbeddingService: () => EmbeddingService }; config: GatewayConfig; logger: Logger } {
    return {
      core: { getVectorStore: () => store, getEmbeddingService: () => fakeEmbedding } as never,
      config: { data: { baseDir: dataDir } } as GatewayConfig,
      logger: silentLogger,
    };
  }

  it("rejects non-JSON Content-Type with 415", async () => {
    const { res, status } = resStub();
    await handleMemoryApply(ctx() as never, makeReq("{}", "text/plain"), res);
    expect(status()).toBe(415);
  });

  it("malformed JSON body → 400", async () => {
    const { res, status } = resStub();
    await handleMemoryApply(ctx() as never, makeReq("{nope"), res);
    expect(status()).toBe(400);
  });

  it("valid empty apply → 200 applied", async () => {
    const { res, status, body } = resStub();
    await handleMemoryApply(ctx() as never, makeReq(JSON.stringify({ diff: {}, manifest: { baseline: {} }, context: { presentedRecordIds: [] } })), res);
    expect(status()).toBe(200);
    expect(body().ok).toBe(true);
  });

  it("invalid diff → 400 with structured result", async () => {
    const { res, status, body } = resStub();
    await handleMemoryApply(ctx() as never, makeReq(JSON.stringify({ wrong: 1 })), res);
    expect(status()).toBe(400);
    expect(body().status).toBe("aborted");
    expect(body().partial).toBe(false);
  });
});
