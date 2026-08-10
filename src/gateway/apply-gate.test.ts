/**
 * tz-09 Ф3 — the apply gate: ops_subset + mechanical caps.
 *
 * Criterion 4 (no path around the gate) is the static check in
 * acceptance-criteria.test.ts; this file is criterion 5: the SAME candidate
 * in shadow passes with a log, in enforce is refused before any mutation.
 *
 * Test names are pinned: `-t "shadow"` and `-t "gate"` must both select a
 * non-empty set (a filter that matches nothing also reports green).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VectorStore } from "../core/store/sqlite.js";
import type { MemoryRecord } from "../core/record/l1-writer.js";
import type { EmbeddingService } from "../core/store/embedding.js";
import type { Logger } from "../core/types.js";
import { ApplyExecutor, countCapUsage } from "./apply-executor.js";
import type { ApplyOp } from "./apply-executor.js";
import type { RunContext } from "./apply-executor.js";

const DIMS = 4;

function fakeVec(seed = 0): Float32Array {
  const v = new Float32Array(DIMS);
  v[seed % DIMS] = 1;
  return v;
}

const fakeEmbedding: EmbeddingService = {
  embed: async (t: string) => fakeVec(t.length),
  embedBatch: async (ts: string[]) => ts.map((t) => fakeVec(t.length)),
  getDimensions: () => DIMS,
  getProviderInfo: () => ({ provider: "fake", model: "fake" }),
  isReady: () => true,
  startWarmup: () => undefined,
  close: async () => undefined,
};

function mem(id: string, content: string): MemoryRecord {
  return {
    id,
    content,
    type: "episodic",
    priority: 50,
    scene_name: "test",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-08-01T00:00:00Z"],
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    sessionKey: "cc-test",
    sessionId: "cc-test",
    projectId: "",
    scope: "global",
  };
}

describe("apply gate: assertOpsSubset + caps (tz-09 Ф3)", () => {
  let dir: string;
  let dataDir: string;
  let store: VectorStore;
  let warns: string[];
  let logger: Logger;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-gate-"));
    dataDir = path.join(dir, "tdai");
    fs.mkdirSync(path.join(dataDir, "scene_blocks", "_global"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(dataDir, ".metadata"), { recursive: true });
    warns = [];
    logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (m: string) => warns.push(m),
      error: () => undefined,
    };
    store = new VectorStore(path.join(dataDir, "vectors.db"), DIMS, logger);
    store.init();
    store.upsertL1(mem("m_a", "alpha"), fakeVec(1));
    store.upsertL1(mem("m_b", "beta"), fakeVec(2));
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function executor(): ApplyExecutor {
    return new ApplyExecutor({
      dataDir,
      logger,
      vectorStore: store,
      embeddingService: fakeEmbedding,
    });
  }

  /** A delete of a presented, existing record — valid in every way EXCEPT the
   * role policy. */
  const candidate = {
    diff: { deleteL1: [{ id: "m_a", updatedAt: "2026-08-01T00:00:00Z" }] },
    manifest: { baseline: {} },
    context: { presentedRecordIds: ["m_a"] },
  };

  const rolePolicy = (mode: RunContext["gateMode"]): RunContext => ({
    runId: "run-1",
    // The role may rewrite blocks, it may NOT delete.
    opsSubset: new Set<ApplyOp>(["rewriteBlock"]),
    caps: { deletePerRun: 50, rewritePerRun: 50 },
    gateMode: mode,
  });

  it("shadow logs and passes", async () => {
    const before = store.countL1();
    const r = await executor().apply(candidate, rolePolicy("shadow"));
    expect(r.status).toBe("applied");
    expect(store.countL1()).toBe(before - 1);
    expect(warns.join("\n")).toMatch(/gate SHADOW.*not in role ops_subset/s);
  });

  it("enforce rejects before mutations", async () => {
    const before = store.countL1();
    const r = await executor().apply(candidate, rolePolicy("enforce"));
    expect(r.status).toBe("aborted");
    expect(r.error).toMatch(/apply gate refused.*ops_subset/);
    expect(r.partial).toBe(false);
    expect(store.countL1()).toBe(before);
  });

  it("no RunContext → pre-tz-09 behaviour (the gate cannot fire)", async () => {
    const r = await executor().apply(candidate);
    expect(r.status).toBe("applied");
    expect(warns.join("\n")).not.toMatch(/gate/);
  });

  it("caps enforced for every apply, not only the chunked strategy", async () => {
    const policy: RunContext = {
      runId: "run-2",
      opsSubset: new Set<ApplyOp>(["deleteL1"]),
      caps: { deletePerRun: 0, rewritePerRun: 0 },
      gateMode: "enforce",
    };
    const r = await executor().apply(candidate, policy);
    expect(r.status).toBe("aborted");
    expect(r.error).toMatch(/delete cap exceeded \(1 > delete_per_run=0\)/);
    expect(store.countL1()).toBe(2);
  });

  it("merge members count as deletes in the cap usage", () => {
    expect(
      countCapUsage({
        merge: [{ cluster: ["a", "b", "c"], target: "a" }],
        deleteL1: [{}],
      }),
    ).toEqual({ deletes: 3, rewrites: 0 });
  });
});
