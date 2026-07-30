import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CheckpointManager } from "./checkpoint.js";
import type { DirtyTier } from "./checkpoint.js";

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
      dirty_l0: {},
      dirty_l1: {},
      last_shutdown_clean: false,
      last_shutdown_ts: 0,
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
      dirty_l0: {},
      dirty_l1: {},
      last_shutdown_clean: false,
      last_shutdown_ts: 0,
    });

    await checkpoint.recalibrateCounts({ totalMemoriesExtracted: 1 });

    const cp = await checkpoint.read();
    expect(cp.total_memories_extracted).toBe(1);
    expect(cp.memories_since_last_persona).toBe(0);
  });
});

// ============================
// Dirty Tracker tests
// ============================

describe("CheckpointManager.dirtyTracker", () => {
  it("setDirtyTiers marks tiers as dirty with dedup", async () => {
    const dataDir = await makeTempDir();
    const cp = new CheckpointManager(dataDir);

    await cp.setDirtyTiers("l0", "session-1", ["jsonl", "sqlite", "checkpoint"]);

    const state = await cp.read();
    expect(state.dirty_l0["session-1"]).toEqual(["jsonl", "sqlite", "checkpoint"]);

    // Repeat with overlapping set — should not duplicate
    await cp.setDirtyTiers("l0", "session-1", ["jsonl", "sqlite"]);
    const state2 = await cp.read();
    expect(state2.dirty_l0["session-1"]).toEqual(["jsonl", "sqlite", "checkpoint"]);
  });

  it("clearDirtyTier removes a single tier and cleans up empty session entries", async () => {
    const dataDir = await makeTempDir();
    const cp = new CheckpointManager(dataDir);

    await cp.setDirtyTiers("l0", "session-1", ["jsonl", "sqlite"]);
    await cp.clearDirtyTier("l0", "session-1", "jsonl");

    const state = await cp.read();
    expect(state.dirty_l0["session-1"]).toEqual(["sqlite"]);

    // Clear last tier — session entry should be removed
    await cp.clearDirtyTier("l0", "session-1", "sqlite");
    const state2 = await cp.read();
    expect(state2.dirty_l0["session-1"]).toBeUndefined();
  });

  it("setDirtyTiers and clearDirtyTier work independently for L0 and L1", async () => {
    const dataDir = await makeTempDir();
    const cp = new CheckpointManager(dataDir);

    await cp.setDirtyTiers("l0", "session-1", ["jsonl"]);
    await cp.setDirtyTiers("l1", "session-1", ["sqlite"]);

    const state = await cp.read();
    expect(state.dirty_l0["session-1"]).toEqual(["jsonl"]);
    expect(state.dirty_l1["session-1"]).toEqual(["sqlite"]);

    await cp.clearDirtyTier("l0", "session-1", "jsonl");
    const state2 = await cp.read();
    expect(state2.dirty_l0["session-1"]).toBeUndefined();
    expect(state2.dirty_l1["session-1"]).toEqual(["sqlite"]);
  });

  it("clearAllDirtyTiers removes all tiers for a session", async () => {
    const dataDir = await makeTempDir();
    const cp = new CheckpointManager(dataDir);

    await cp.setDirtyTiers("l1", "session-1", ["jsonl", "sqlite", "checkpoint"]);
    await cp.clearAllDirtyTiers("l1", "session-1");

    const state = await cp.read();
    expect(state.dirty_l1["session-1"]).toBeUndefined();
  });

  it("getDirtyTiers returns empty array for clean sessions", async () => {
    const dataDir = await makeTempDir();
    const cp = new CheckpointManager(dataDir);

    const state = await cp.read();
    expect(cp.getDirtyTiers(state, "l0", "nonexistent")).toEqual([]);
  });

  it("getDirtySessions returns all sessions with dirty tiers", async () => {
    const dataDir = await makeTempDir();
    const cp = new CheckpointManager(dataDir);

    await cp.setDirtyTiers("l0", "session-a", ["jsonl"]);
    await cp.setDirtyTiers("l0", "session-b", ["sqlite"]);

    const state = await cp.read();
    const sessions = cp.getDirtySessions(state, "l0");
    expect(sessions).toEqual(expect.arrayContaining(["session-a", "session-b"]));
    expect(sessions.length).toBe(2);
  });
});

// ============================
// Clean Shutdown Flag tests
// ============================

describe("CheckpointManager.shutdownFlag", () => {
  it("markShutdownClean sets last_shutdown_clean and last_shutdown_ts", async () => {
    const dataDir = await makeTempDir();
    const cp = new CheckpointManager(dataDir);

    await cp.markShutdownClean();

    const state = await cp.read();
    expect(state.last_shutdown_clean).toBe(true);
    expect(state.last_shutdown_ts).toBeGreaterThan(0);
  });

  it("markShutdownDirty sets last_shutdown_clean to false", async () => {
    const dataDir = await makeTempDir();
    const cp = new CheckpointManager(dataDir);

    await cp.markShutdownClean(); // true
    await cp.markShutdownDirty(); // back to false

    const state = await cp.read();
    expect(state.last_shutdown_clean).toBe(false);
  });
});

// ============================
// Cursor recalibration tests
// ============================

describe("CheckpointManager.recalibrateCursor", () => {
  it("advances L0 cursor with Math.max and clears dirty markers atomically", async () => {
    const dataDir = await makeTempDir();
    const cp = new CheckpointManager(dataDir);

    // Set initial state
    await cp.write({
      last_captured_timestamp: 0,
      total_processed: 0,
      last_persona_at: 0,
      last_persona_time: "",
      request_persona_update: false,
      persona_update_reason: "",
      memories_since_last_persona: 0,
      scenes_processed: 0,
      runner_states: { "session-1": { last_captured_timestamp: 100, last_l1_cursor: 0, last_scene_name: "" } },
      pipeline_states: {},
      l0_conversations_count: 0,
      total_memories_extracted: 0,
      dirty_l0: { "session-1": ["jsonl", "sqlite", "checkpoint"] },
      dirty_l1: {},
      last_shutdown_clean: false,
      last_shutdown_ts: 0,
    });

    // Recalibrate to a later timestamp
    await cp.recalibrateCursor("session-1", "l0", 500);

    const state = await cp.read();
    expect(state.runner_states["session-1"].last_captured_timestamp).toBe(500);
    expect(state.dirty_l0["session-1"]).toBeUndefined();
  });

  it("never retreats L0 cursor (Math.max with earlier timestamp)", async () => {
    const dataDir = await makeTempDir();
    const cp = new CheckpointManager(dataDir);

    await cp.setDirtyTiers("l0", "session-1", ["sqlite"]);
    // Set runner state directly
    await cp.write({
      ...(await cp.read()),
      runner_states: { "session-1": { last_captured_timestamp: 1000, last_l1_cursor: 0, last_scene_name: "" } },
    });

    // Try to recalibrate with an earlier timestamp
    await cp.recalibrateCursor("session-1", "l0", 100);

    const state = await cp.read();
    expect(state.runner_states["session-1"].last_captured_timestamp).toBe(1000); // unchanged
  });

  it("recalibrateCursor advances L1 cursor and clears dirty markers", async () => {
    const dataDir = await makeTempDir();
    const cp = new CheckpointManager(dataDir);

    await cp.write({
      last_captured_timestamp: 0,
      total_processed: 0,
      last_persona_at: 0,
      last_persona_time: "",
      request_persona_update: false,
      persona_update_reason: "",
      memories_since_last_persona: 0,
      scenes_processed: 0,
      runner_states: { "session-1": { last_captured_timestamp: 0, last_l1_cursor: 100, last_scene_name: "" } },
      pipeline_states: {},
      l0_conversations_count: 0,
      total_memories_extracted: 0,
      dirty_l1: { "session-1": ["checkpoint"] },
      dirty_l0: {},
      last_shutdown_clean: false,
      last_shutdown_ts: 0,
    });

    await cp.recalibrateCursor("session-1", "l1", 500, "scene-2");

    const state = await cp.read();
    expect(state.runner_states["session-1"].last_l1_cursor).toBe(500);
    expect(state.runner_states["session-1"].last_scene_name).toBe("scene-2");
    expect(state.dirty_l1["session-1"]).toBeUndefined();
  });
});

// ============================
// Backward compatibility tests
// ============================

describe("CheckpointManager.backwardCompat", () => {
  it("old checkpoint without dirty/shutdown fields gets defaults", async () => {
    const dataDir = await makeTempDir();
    const cp = new CheckpointManager(dataDir);

    // Write an old-style checkpoint (no new fields)
    await cp.write({
      last_captured_timestamp: 0,
      total_processed: 0,
      last_persona_at: 0,
      last_persona_time: "",
      request_persona_update: false,
      persona_update_reason: "",
      memories_since_last_persona: 0,
      scenes_processed: 0,
      runner_states: {},
      pipeline_states: {},
      l0_conversations_count: 0,
      total_memories_extracted: 0,
    } as any);

    const state = await cp.read();
    expect(state.dirty_l0).toEqual({});
    expect(state.dirty_l1).toEqual({});
    expect(state.last_shutdown_clean).toBe(false);
    expect(state.last_shutdown_ts).toBe(0);
  });
});
