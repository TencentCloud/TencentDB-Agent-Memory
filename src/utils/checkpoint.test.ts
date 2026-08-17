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
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("CheckpointManager.recountFromDisk", () => {
  it("recalibrates L0 and L1 counters using callback-provided values", async () => {
    const dataDir = await makeTempDir();
    const checkpoint = new CheckpointManager(dataDir);

    // Seed with stale counters
    await checkpoint.write({
      last_captured_timestamp: 0,
      total_processed: 20,
      last_persona_at: 0,
      last_persona_time: "",
      request_persona_update: false,
      persona_update_reason: "",
      memories_since_last_persona: 12,
      scenes_processed: 0,
      runner_states: {},
      pipeline_states: {},
      l0_conversations_count: 20,
      total_memories_extracted: 15,
    });

    // Callbacks simulate counting actual on-disk records
    await checkpoint.recountFromDisk(
      async () => 5, // L0 conversations actually on disk
      async () => 8, // L1 memories actually on disk
    );

    const cp = await checkpoint.read();
    expect(cp.l0_conversations_count).toBe(5);
    expect(cp.total_memories_extracted).toBe(8);
    // Other fields should be preserved
    expect(cp.total_processed).toBe(20);
    expect(cp.memories_since_last_persona).toBe(12);
  });

  it("leaves counters unchanged when the count callback throws", async () => {
    const dataDir = await makeTempDir();
    const checkpoint = new CheckpointManager(dataDir, {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    });

    await checkpoint.write({
      last_captured_timestamp: 0,
      total_processed: 10,
      last_persona_at: 0,
      last_persona_time: "",
      request_persona_update: false,
      persona_update_reason: "",
      memories_since_last_persona: 0,
      scenes_processed: 0,
      runner_states: {},
      pipeline_states: {},
      l0_conversations_count: 10,
      total_memories_extracted: 10,
    });

    // Callback that always fails (e.g., DB connection lost)
    await checkpoint.recountFromDisk(
      async () => { throw new Error("DB unavailable"); },
      async () => 0,
    );

    // Counters should be unchanged after error
    const cp = await checkpoint.read();
    expect(cp.l0_conversations_count).toBe(10);
    expect(cp.total_memories_extracted).toBe(10);
  });

  it("handles zero-count recalibration (all data pruned)", async () => {
    const dataDir = await makeTempDir();
    const checkpoint = new CheckpointManager(dataDir);

    await checkpoint.write({
      last_captured_timestamp: 0,
      total_processed: 100,
      last_persona_at: 0,
      last_persona_time: "",
      request_persona_update: false,
      persona_update_reason: "",
      memories_since_last_persona: 5,
      scenes_processed: 0,
      runner_states: {},
      pipeline_states: {},
      l0_conversations_count: 100,
      total_memories_extracted: 50,
    });

    // Everything was cleaned up
    await checkpoint.recountFromDisk(
      async () => 0,
      async () => 0,
    );

    const cp = await checkpoint.read();
    expect(cp.l0_conversations_count).toBe(0);
    expect(cp.total_memories_extracted).toBe(0);
  });

  it("supports callback-based counting for flexibility", async () => {
    const dataDir = await makeTempDir();
    const checkpoint = new CheckpointManager(dataDir);

    // Demonstrate that callbacks can use any data source —
    // they don't need to know about vector stores internally
    let callCount = 0;
    const trackedValues: number[] = [];

    await checkpoint.recountFromDisk(
      async () => {
        callCount++;
        // In real code this could read from a file, DB, or API
        const files = await fs.readdir(dataDir);
        trackedValues.push(files.length);
        return files.length;
      },
      async () => {
        callCount++;
        return 42; // Could be any async computation
      },
    );

    expect(callCount).toBe(2);
    const cp = await checkpoint.read();
    expect(cp.total_memories_extracted).toBe(42);
  });
});
