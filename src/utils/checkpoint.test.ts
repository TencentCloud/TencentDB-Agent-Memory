import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CheckpointManager } from "./checkpoint.js";

const tempDirs: string[] = [];

async function createManager(): Promise<{ checkpoint: CheckpointManager; dataDir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-tdai-checkpoint-"));
  tempDirs.push(dir);
  return { checkpoint: new CheckpointManager(dir), dataDir: dir };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CheckpointManager record-count reconciliation", () => {
  it("counts captured L0 messages rather than capture batches", async () => {
    const { checkpoint } = await createManager();

    await checkpoint.captureAtomically("session-a", undefined, async () => ({
      maxTimestamp: 100,
      messageCount: 3,
    }));

    const state = await checkpoint.read();
    expect(state.l0_conversations_count).toBe(3);
    expect(state.total_processed).toBe(3);
  });

  it("replaces inflated retained-record counters with authoritative counts", async () => {
    const { checkpoint } = await createManager();
    const initial = await checkpoint.read();
    await checkpoint.write({
      ...initial,
      l0_conversations_count: 999,
      total_memories_extracted: 888,
      total_processed: 1234,
      memories_since_last_persona: 42,
    });

    await checkpoint.recalculateRecordCounts({ l0Conversations: 7, l1Memories: 4 });

    const state = await checkpoint.read();
    expect(state.l0_conversations_count).toBe(7);
    expect(state.total_memories_extracted).toBe(4);
    // Reconciliation must not turn record inventory into a progress cursor.
    expect(state.total_processed).toBe(1234);
    expect(state.memories_since_last_persona).toBe(42);
  });

  it("recalculates local JSONL counts after a manual file trim", async () => {
    const { checkpoint, dataDir } = await createManager();
    await mkdir(path.join(dataDir, "conversations"), { recursive: true });
    await mkdir(path.join(dataDir, "records"), { recursive: true });
    await writeFile(
      path.join(dataDir, "conversations", "2026-07-22.jsonl"),
      '{"id":"l0-1"}\nnot-json\n{"id":"l0-2"}\n',
      "utf-8",
    );
    await writeFile(
      path.join(dataDir, "records", "2026-07-22.jsonl"),
      '{"id":"l1-1"}\n',
      "utf-8",
    );

    const counts = await checkpoint.recalculateLocalRecordCounts();
    const state = await checkpoint.read();
    expect(counts).toEqual({ l0Conversations: 2, l1Memories: 1 });
    expect(state.l0_conversations_count).toBe(2);
    expect(state.total_memories_extracted).toBe(1);
  });

  it("resets only the selected session's progress so rolled-back data can be reprocessed", async () => {
    const { checkpoint } = await createManager();
    await checkpoint.markL1ExtractionComplete("replace-me", 2, 100, "old scene");
    await checkpoint.markL1ExtractionComplete("keep-me", 1, 200, "keep scene");
    await checkpoint.mergePipelineStates({
      "replace-me": {
        conversation_count: 3,
        last_extraction_time: "2026-01-01T00:00:00.000Z",
        last_extraction_updated_time: "2026-01-01T00:00:00.000Z",
        last_active_time: 100,
        l2_pending_l1_count: 3,
        warmup_threshold: 4,
        l2_last_extraction_time: "",
      },
      "keep-me": {
        conversation_count: 1,
        last_extraction_time: "",
        last_extraction_updated_time: "",
        last_active_time: 200,
        l2_pending_l1_count: 0,
        warmup_threshold: 1,
        l2_last_extraction_time: "",
      },
    });

    await checkpoint.resetSessionProgress("replace-me");

    const state = await checkpoint.read();
    expect(state.runner_states["replace-me"]).toBeUndefined();
    expect(state.pipeline_states["replace-me"]).toBeUndefined();
    expect(state.runner_states["keep-me"].last_l1_cursor).toBe(200);
    expect(state.pipeline_states["keep-me"].conversation_count).toBe(1);
  });
});
