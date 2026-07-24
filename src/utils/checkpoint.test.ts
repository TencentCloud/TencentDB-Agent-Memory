import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CheckpointManager } from "./checkpoint.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-checkpoint-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("CheckpointManager.recalibrateCounts", () => {
  it("reconciles L0 and L1 counters with actual storage counts", async () => {
    const dataDir = await makeTempDir();
    const checkpoint = new CheckpointManager(dataDir);

    await checkpoint.write({
      last_captured_timestamp: 0,
      total_processed: 12,
      last_persona_at: 0,
      last_persona_time: "",
      request_persona_update: false,
      persona_update_reason: "",
      memories_since_last_persona: 8,
      scenes_processed: 0,
      runner_states: {},
      pipeline_states: {},
      l0_conversations_count: 12,
      total_memories_extracted: 10,
    });

    await checkpoint.recalibrateCounts({
      l0ConversationsCount: 4,
      totalMemoriesExtracted: 6,
    });

    const cp = await checkpoint.read();
    expect(cp.l0_conversations_count).toBe(4);
    expect(cp.total_memories_extracted).toBe(6);
    expect(cp.memories_since_last_persona).toBe(4);
  });

  it("does not let memories_since_last_persona go below zero", async () => {
    const dataDir = await makeTempDir();
    const checkpoint = new CheckpointManager(dataDir);

    await checkpoint.write({
      last_captured_timestamp: 0,
      total_processed: 0,
      last_persona_at: 0,
      last_persona_time: "",
      request_persona_update: false,
      persona_update_reason: "",
      memories_since_last_persona: 2,
      scenes_processed: 0,
      runner_states: {},
      pipeline_states: {},
      l0_conversations_count: 0,
      total_memories_extracted: 10,
    });

    await checkpoint.recalibrateCounts({ totalMemoriesExtracted: 1 });

    const cp = await checkpoint.read();
    expect(cp.total_memories_extracted).toBe(1);
    expect(cp.memories_since_last_persona).toBe(0);
  });
});
