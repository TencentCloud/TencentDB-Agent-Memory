// Regression tests for the opt-in fail-closed dedup behavior.
//
// Production evidence (private multi-session deployment, 2026-10-08..10-12):
// 53 batch-dedup failures in 5 days all hit the inner swallow and stored their
// whole batch unchecked — duplicating existing memories. With
// `dedupFailFast: true`, a dedup failure must reject (so the caller can defer
// the batch) instead of silently defaulting to store-all.
//
// Boundary pin: the parse-degraded fallback inside parseBatchResult (LLM
// returns unparsable text → store-all) is intentionally preserved even with
// the flag on — fail-closed covers call failures, not parse degradation.
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { batchDedup } from "./l1-dedup.js";
import type { IMemoryStore } from "../store/types.js";
import type { LLMRunner } from "../types.js";

const MEM = {
  record_id: "new-1",
  content: "Daily-backup rule: any failed step must be reported explicitly, never silently swallowed",
  type: "instruction" as const,
  priority: 90,
  scene_name: "s",
  source_message_ids: [] as string[],
  metadata: {},
};

function makeStore(opts: { ftsResults: unknown[] }): IMemoryStore {
  return {
    countL1: async () => 2546,
    isDegraded: () => false,
    isFtsAvailable: () => true,
    searchL1Vector: async () => [],
    searchL1Fts: async () => opts.ftsResults,
  } as unknown as IMemoryStore;
}

const FTS_ROW = {
  record_id: "old-1",
  content: "Daily-backup rule: verify backup results (exit code, copies, file presence)",
  type: "instruction",
  priority: 90,
  scene_name: "s",
  metadata_json: "",
  timestamp_str: "2026-09-11T00:00:00Z",
  session_key: "k",
  session_id: "d",
};

const timeoutRunner = {
  run: async () => {
    throw new Error("The operation was aborted due to timeout");
  },
} as unknown as LLMRunner;

describe("batchDedup dedupFailFast (fail-closed opt-in)", () => {
  it("flag on + LLM judgment failure → batchDedup rejects (no unchecked store)", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "dedup-failfast-"));
    try {
      await expect(
        batchDedup({
          memories: [MEM],
          config: {},
          dedupFailFast: true,
          vectorStore: makeStore({ ftsResults: [FTS_ROW] }),
          llmRunner: timeoutRunner,
        }),
      ).rejects.toThrow(/aborted due to timeout/);
      // Failure path must not write anything (no unchecked store).
      expect(existsSync(join(baseDir, "records"))).toBe(false);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("flag off (default) → keeps the existing degraded store-all behavior", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "dedup-failfast-off-"));
    try {
      const decisions = await batchDedup({
        memories: [MEM],
        config: {},
        vectorStore: makeStore({ ftsResults: [FTS_ROW] }),
        llmRunner: timeoutRunner,
      });
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ record_id: "new-1", action: "store" });
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("boundary pin: flag on + unparsable LLM text (parse degradation) → still store-all, no throw", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "dedup-failfast-parse-"));
    try {
      const garbage = { run: async () => "definitely not json" } as unknown as LLMRunner;
      const decisions = await batchDedup({
        memories: [MEM],
        config: {},
        dedupFailFast: true,
        vectorStore: makeStore({ ftsResults: [FTS_ROW] }),
        llmRunner: garbage,
      });
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ action: "store" });
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
