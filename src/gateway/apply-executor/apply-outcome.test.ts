/**
 * tz-09 — what an apply leaves behind (critic round 1).
 *
 * Three defects the critic reproduced, each pinned here:
 *   1. a failing apply left the Run in `applying` forever — takeover from
 *      `applying` is forbidden, so the run was wedged with no exit;
 *   2. the operation index followed the COMPACTED delete list, so one skipped
 *      id shifted every later operationId onto the wrong target;
 *   3. `verified` meant "the row exists", which is true BEFORE a merge or a
 *      rewrite too — a vacuous check.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { VectorStore } from "../../core/store/sqlite.js";
import { ApplyExecutor } from "../apply-executor.js";
import { createRun, readRun, updateRun } from "../control-plane/run-repo.js";
import { digestOf } from "./op-journal.js";
import { listOps } from "../control-plane/oplog.js";
import { beginApplying, finishApplying } from "../control-plane/applying.js";
import { reconcileRun } from "../control-plane/reconcile.js";
import type { EmbeddingService } from "../../core/store/embedding.js";
import type { Logger } from "../../core/types.js";

const DIMS = 4;
const NOW = "2026-08-10T22:30:00.000Z";
const UPDATED = "2026-08-01T00:00:00Z";

const vec = (seed: number) => {
  const v = new Float32Array(DIMS);
  v[seed % DIMS] = 1;
  return v;
};
const embedding: EmbeddingService = {
  embed: async (t: string) => vec(t.length),
  embedBatch: async (ts: string[]) => ts.map((t) => vec(t.length)),
  getDimensions: () => DIMS,
  getProviderInfo: () => ({ provider: "fake", model: "fake" }),
  isReady: () => true,
  startWarmup: () => undefined,
  close: async () => undefined,
};
const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("apply outcome and journal fidelity (tz-09)", () => {
  let dir: string;
  let dataDir: string;
  let store: VectorStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-outcome-"));
    dataDir = path.join(dir, "tdai");
    fs.mkdirSync(path.join(dataDir, "scene_blocks", "_global"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(dataDir, ".metadata"), { recursive: true });
    store = new VectorStore(path.join(dataDir, "vectors.db"), DIMS, logger);
    store.init();
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(id: string, content = `content of ${id}`): void {
    store.upsertL1(
      {
        id,
        content,
        type: "episodic",
        priority: 50,
        scene_name: "test",
        source_message_ids: [],
        metadata: {},
        timestamps: [UPDATED],
        createdAt: UPDATED,
        updatedAt: UPDATED,
        sessionKey: "test",
        sessionId: "test",
        projectId: "",
        scope: "global",
      } as never,
      vec(id.length),
    );
  }

  function run(runId: string, ops: string[]): void {
    createRun(
      dataDir,
      {
        runId,
        roleId: "memory-keeper",
        contractHash: "h",
        contractJson: JSON.stringify({
          policy: {
            opsSubset: ops,
            caps: { deletePerRun: 10, rewritePerRun: 10 },
          },
        }),
        binding: "{}",
      },
      NOW,
    );
  }

  const executor = () =>
    new ApplyExecutor({
      dataDir,
      logger,
      vectorStore: store,
      embeddingService: embedding,
      runRepo: true,
    });

  /** Body + the critic receipt that makes this exact diff appliable: in
   * enforce, apply refuses a candidate no verdict named (run-policy.ts). */
  const body = (
    runId: string,
    diff: Record<string, unknown>,
    presented: string[],
  ) => {
    updateRun(
      dataDir,
      runId,
      {
        state: "reviewed",
        candidateDigest: digestOf(JSON.stringify(diff)),
        verdictDigest: "v",
        criticReceipt: '{"verdict":"approve"}',
      },
      NOW,
    );
    return {
      diff,
      manifest: { baseline: {} },
      context: { presentedRecordIds: presented },
    };
  };

  it("an apply that mutated and then failed parks the run, it does not wedge it", async () => {
    seed("m_a");
    seed("m_b");
    seed("m_c");
    run("r-partial", ["merge", "deleteL1"]);

    const res = await executor().apply(
      body(
        "r-partial",
        {
          merge: [{ cluster: ["m_a", "m_b"], target: "m_a", content: "AB" }],
          deleteL1: [{ id: "m_c", updatedAt: "2026-07-01T00:00:00Z" }],
        },
        ["m_a", "m_b", "m_c"],
      ),
      { runId: "r-partial", candidateDigest: "d", gateMode: "enforce" },
    );

    expect(res.status).toBe("aborted");
    expect(res.partial).toBe(true);
    expect(readRun(dataDir, "r-partial")?.state).toBe("needs-reconciliation");
  });

  it("a gate refusal never opens the door: the run is untouched, not applying", async () => {
    seed("m_x");
    run("r-clean", ["rewriteBlock"]);

    const res = await executor().apply(
      body("r-clean", { deleteL1: [{ id: "m_x", updatedAt: UPDATED }] }, [
        "m_x",
      ]),
      { runId: "r-clean", candidateDigest: "d", gateMode: "enforce" },
    );

    expect(res.status).toBe("aborted");
    expect(res.partial).toBe(false);
    // The gate refuses BEFORE the door, so the run never entered `applying`
    // and keeps the state it had — the wedge is impossible here by ordering.
    expect(readRun(dataDir, "r-clean")?.state).toBe("reviewed");
    expect(store.countL1()).toBe(1);
  });

  it("a skipped delete does not shift the operation index of the next one", async () => {
    seed("m_keep");
    run("r-index", ["deleteL1"]);

    const res = await executor().apply(
      body(
        "r-index",
        {
          deleteL1: [
            { id: "m_gone", updatedAt: UPDATED }, // not in the store → skipped
            { id: "m_keep", updatedAt: UPDATED },
          ],
        },
        ["m_gone", "m_keep"],
      ),
      { runId: "r-index", candidateDigest: "d", gateMode: "enforce" },
    );

    expect(res.status).toBe("applied");
    expect(res.skipped.deletes).toEqual(["m_gone"]);
    const ops = listOps(dataDir, "r-index");
    expect(ops).toHaveLength(1);
    // Position in the REQUEST (1), not in the compacted list (0).
    expect(ops[0]?.opIndex).toBe(1);
    expect(ops[0]?.targetKey).toBe("m_keep");
  });

  it("verification compares content, so a target that merely exists is not verified", async () => {
    seed("m_1", "original");
    run("r-rewrite", ["rewriteRecord"]);

    const res = await executor().apply(
      body(
        "r-rewrite",
        {
          rewriteRecord: [
            { id: "m_1", updatedAt: UPDATED, content: "rewritten" },
          ],
        },
        ["m_1"],
      ),
      { runId: "r-rewrite", candidateDigest: "d", gateMode: "enforce" },
    );
    expect(res.status).toBe("applied");

    const [op] = listOps(dataDir, "r-rewrite");
    expect(op?.payloadDigest).toBe(
      createHash("sha256").update("rewritten").digest("hex"),
    );
    expect(reconcileRun(dataDir, "r-rewrite", NOW).resolved).toBe(true);

    // Someone rewrites the record behind the protocol's back: the row still
    // exists, but the operation's effect is gone — and reconciliation says so.
    store.upsertL1(
      {
        id: "m_1",
        content: "someone else's text",
        type: "episodic",
        priority: 50,
        scene_name: "test",
        source_message_ids: [],
        metadata: {},
        timestamps: [UPDATED],
        createdAt: UPDATED,
        updatedAt: UPDATED,
        sessionKey: "test",
        sessionId: "test",
        projectId: "",
        scope: "global",
      } as never,
      vec(3),
    );
    const again = reconcileRun(dataDir, "r-rewrite", NOW);
    expect(again.resolved).toBe(false);
    expect(again.unresolved[0]?.detail).toContain("content differs");
  });

  it("a raw throw from the store still lets the run out of `applying`", async () => {
    seed("m_raw");
    run("r-raw", ["deleteL1"]);

    // Not one of the four typed errors: the store itself blows up mid-apply
    // (SQLITE_BUSY and friends land here), which used to skip every exit hook.
    const broken = new ApplyExecutor({
      dataDir,
      logger,
      vectorStore: {
        ...(store as unknown as Record<string, unknown>),
        deleteL1Batch: async () => {
          throw new Error("SQLITE_BUSY: database is locked");
        },
      } as never,
      embeddingService: embedding,
      runRepo: true,
    });

    await expect(
      broken.apply(
        body("r-raw", { deleteL1: [{ id: "m_raw", updatedAt: UPDATED }] }, [
          "m_raw",
        ]),
        {
          runId: "r-raw",
          candidateDigest: "d",
          gateMode: "enforce",
        },
      ),
    ).rejects.toThrow(/SQLITE_BUSY/);

    expect(readRun(dataDir, "r-raw")?.state).not.toBe("applying");
  });

  it("a handler refused at the door does not write its outcome onto the in-flight run", async () => {
    seed("m_door");
    run("r-door", ["deleteL1"]);

    // The verdict lands first, exactly as it does in a real run…
    const req = body(
      "r-door",
      { deleteL1: [{ id: "m_door", updatedAt: UPDATED }] },
      ["m_door"],
    );
    // …then handler A is mid-apply: it holds `applying`.
    expect(beginApplying(dataDir, "r-door", NOW).ok).toBe(true);

    // Handler B arrives, is refused at the door — and must leave A's run alone.
    const res = await executor().apply(req, {
      runId: "r-door",
      candidateDigest: "d",
      gateMode: "enforce",
    });
    expect(res.status).toBe("aborted");
    expect(res.error).toMatch(/applying/);
    expect(readRun(dataDir, "r-door")?.state).toBe("applying");

    // …so A's own finish still lands: its outcome is not lost.
    finishApplying(dataDir, "r-door", "needs-reconciliation", NOW);
    expect(readRun(dataDir, "r-door")?.state).toBe("needs-reconciliation");
  });
});
