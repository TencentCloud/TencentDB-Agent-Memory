import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CheckpointManager } from "./checkpoint.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tdai-checkpoint-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CheckpointManager.recalibrate", () => {
  it("overwrites aggregate counters and preserves per-session state", async () => {
    const dir = await makeTempDir();
    const manager = new CheckpointManager(dir);
    const checkpoint = await manager.read();
    checkpoint.total_processed = 120;
    checkpoint.memories_since_last_persona = 30;
    checkpoint.l0_conversations_count = 40;
    checkpoint.total_memories_extracted = 50;
    checkpoint.last_persona_time = "2026-06-01T00:00:00.000Z";
    checkpoint.runner_states.sessionA = {
      last_captured_timestamp: 123,
      last_l1_cursor: 456,
      last_scene_name: "scene-a",
    };
    checkpoint.pipeline_states.sessionA = {
      conversation_count: 7,
      last_extraction_time: "2026-06-02T00:00:00.000Z",
      last_extraction_updated_time: "2026-06-02T00:00:00.000Z",
      last_active_time: 789,
      l2_pending_l1_count: 3,
      warmup_threshold: 4,
      l2_last_extraction_time: "2026-06-03T00:00:00.000Z",
    };
    await manager.write(checkpoint);

    const result = await manager.recalibrate({
      total_processed: 12,
      memories_since_last_persona: 3,
      l0_conversations_count: 4,
      total_memories_extracted: 5,
    });

    expect(result.changed).toBe(true);
    expect(result.before).toEqual({
      total_processed: 120,
      memories_since_last_persona: 30,
      l0_conversations_count: 40,
      total_memories_extracted: 50,
    });
    expect(result.after).toEqual({
      total_processed: 12,
      memories_since_last_persona: 3,
      l0_conversations_count: 4,
      total_memories_extracted: 5,
    });

    const after = await manager.read();
    expect(after.runner_states.sessionA).toEqual(checkpoint.runner_states.sessionA);
    expect(after.pipeline_states.sessionA).toEqual(checkpoint.pipeline_states.sessionA);
    expect(after.last_persona_time).toBe("2026-06-01T00:00:00.000Z");
  });

  it("supports partial no-op recalibration reports", async () => {
    const dir = await makeTempDir();
    const manager = new CheckpointManager(dir);

    await manager.recalibrate({ total_processed: 2 });
    const result = await manager.recalibrate({ total_processed: 2 });

    expect(result.changed).toBe(false);
    expect(result.before.total_processed).toBe(2);
    expect(result.after.total_processed).toBe(2);
  });

  it("rejects negative and fractional counts", async () => {
    const dir = await makeTempDir();
    const manager = new CheckpointManager(dir);

    await expect(manager.recalibrate({ total_processed: -1 })).rejects.toThrow(RangeError);
    await expect(manager.recalibrate({ total_memories_extracted: 1.5 })).rejects.toThrow(RangeError);
  });
});
