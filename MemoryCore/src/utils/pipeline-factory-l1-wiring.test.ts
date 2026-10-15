// Regression test for the P2 review finding on PR #1641: the
// `extraction.dedupFailFast` switch was parsed in config.ts but never passed
// through createL1Runner into extractL1Memories, so the opt-in fail-closed
// mode never engaged on the production path.
//
// This test drives the FULL production path — parseConfig → createL1Runner →
// runner invocation → extractL1Memories → batchDedup — with only the LLM
// runner and the vector store stubbed, and pins the reviewer's contract:
//   - flag on  + dedup judgment failure → runner rejects, nothing stored,
//     checkpoint cursor does not advance (batch stays queued for retry);
//   - flag off (default)               → legacy store-all + cursor advance,
//     documenting the exact behavior the switch gates.
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createL1Runner } from "./pipeline-factory.js";
import { CheckpointManager } from "./checkpoint.js";
import { parseConfig } from "../config.js";
import type { IMemoryStore } from "../core/store/types.js";
import type { LLMRunner, PipelineLogger } from "../core/types.js";

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

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as PipelineLogger;

function makeStore() {
  const writes: unknown[] = [];
  const store = {
    countL1: async () => 2546,
    isDegraded: () => false,
    isFtsAvailable: () => true,
    searchL1Vector: async () => [],
    searchL1Fts: async () => [FTS_ROW],
    queryL0GroupedBySessionId: async () => [
      {
        sessionId: "sess-1",
        teamId: undefined,
        taskId: undefined,
        userId: "u1",
        agentId: "a1",
        messages: [
          { id: "m1", role: "user", content: "please remember: report failures explicitly", timestamp: 1000, recordedAtMs: 1000 },
          { id: "m2", role: "assistant", content: "noted, that is our standing rule", timestamp: 2000, recordedAtMs: 2000 },
        ],
      },
    ],
    addL1: async (record: unknown) => {
      writes.push(record);
      return record;
    },
  } as unknown as IMemoryStore;
  return { store, writes };
}

// Extraction call (taskId=l1-extraction) returns one memory; the dedup
// judgment call (taskId=l1-conflict-detection) fails with a timeout — the
// same synthetic failure the reviewer used for the reproduction.
const dualLlmRunner = {
  run: async (p: { taskId?: string }) => {
    if (p.taskId === "l1-extraction") {
      return JSON.stringify([
        {
          scene_name: "s",
          message_ids: ["m1"],
          memories: [
            {
              content: "Daily-backup rule: report failures explicitly, never silently swallow them",
              type: "instruction",
              priority: 90,
            },
          ],
        },
      ]);
    }
    throw new Error("The operation was aborted due to timeout");
  },
} as unknown as LLMRunner;

function makeRunner(pluginDataDir: string, dedupFailFast: boolean) {
  const { store, writes } = makeStore();
  const cfg = parseConfig({
    extraction: { enableDedup: true, dedupFailFast, maxMemoriesPerSession: 10 },
  });
  const runner = createL1Runner({
    pluginDataDir,
    cfg,
    openclawConfig: undefined,
    vectorStore: store,
    embeddingService: undefined,
    logger: noopLogger,
    llmRunner: dualLlmRunner,
  });
  return { runner, writes };
}

async function readCursor(pluginDataDir: string, sessionKey: string): Promise<number> {
  const cpManager = new CheckpointManager(pluginDataDir, noopLogger);
  const cp = await cpManager.read();
  return cpManager.getRunnerState(cp, sessionKey).last_l1_cursor;
}

describe("createL1Runner wires extraction.dedupFailFast into the production L1 path", () => {
  it("flag on + dedup failure → runner rejects, zero writes, cursor does not advance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "l1-wiring-on-"));
    try {
      const { runner, writes } = makeRunner(dir, true);
      await expect(runner({ sessionKey: "sess-1" })).rejects.toThrow(/aborted due to timeout/);
      expect(writes).toHaveLength(0);
      expect(existsSync(join(dir, "records"))).toBe(false);
      expect(await readCursor(dir, "sess-1")).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flag off (default) → legacy store-all keeps working and the cursor advances", async () => {
    const dir = mkdtempSync(join(tmpdir(), "l1-wiring-off-"));
    try {
      const { runner } = makeRunner(dir, false);
      const result = await runner({ sessionKey: "sess-1" });
      expect(result.storedCount).toBe(1);
      expect(existsSync(join(dir, "records"))).toBe(true);
      expect(await readCursor(dir, "sess-1")).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
