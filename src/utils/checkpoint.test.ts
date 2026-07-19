import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CheckpointManager, type Checkpoint } from "./checkpoint.js";

/**
 * Unit tests for CheckpointManager.recalibrate() — the fix for issue #157
 * ("total_memories_extracted / l0_conversations_count only ever increase").
 */
describe("CheckpointManager.recalibrate", () => {
  let dataDir: string;
  let mgr: CheckpointManager;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-checkpoint-test-"));
    mgr = new CheckpointManager(dataDir);
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  async function seed(fields: Partial<Checkpoint>): Promise<void> {
    const cp = await mgr.read();
    Object.assign(cp, fields);
    await mgr.write(cp);
  }

  it("lowers inflated counters to the actual store counts", async () => {
    // Issue #157 reproduction: checkpoint says 50, real store has 42.
    await seed({
      total_memories_extracted: 50,
      l0_conversations_count: 30,
      memories_since_last_persona: 10,
    });

    await mgr.recalibrate({ totalMemoriesExtracted: 42, l0ConversationsCount: 25 });

    const cp = await mgr.read();
    expect(cp.total_memories_extracted).toBe(42);
    expect(cp.l0_conversations_count).toBe(25);
  });

  it("reduces memories_since_last_persona by the L1 drift", async () => {
    await seed({
      total_memories_extracted: 50,
      l0_conversations_count: 30,
      memories_since_last_persona: 10,
    });

    await mgr.recalibrate({ totalMemoriesExtracted: 42, l0ConversationsCount: 25 });

    // drift = 50 - 42 = 8 → 10 - 8 = 2
    const cp = await mgr.read();
    expect(cp.memories_since_last_persona).toBe(2);
  });

  it("clamps memories_since_last_persona at 0 when the drift exceeds it", async () => {
    await seed({
      total_memories_extracted: 50,
      l0_conversations_count: 30,
      memories_since_last_persona: 5,
    });

    await mgr.recalibrate({ totalMemoriesExtracted: 42, l0ConversationsCount: 25 });

    const cp = await mgr.read();
    expect(cp.memories_since_last_persona).toBe(0);
  });

  it("never leaves memories_since_last_persona above the actual L1 total", async () => {
    // Already-inconsistent state: since-persona counter exceeds the global total.
    await seed({
      total_memories_extracted: 50,
      l0_conversations_count: 30,
      memories_since_last_persona: 60,
    });

    await mgr.recalibrate({ totalMemoriesExtracted: 42, l0ConversationsCount: 25 });

    const cp = await mgr.read();
    expect(cp.memories_since_last_persona).toBeLessThanOrEqual(42);
  });

  it("raises counters when the store holds more than the checkpoint (restored backup)", async () => {
    await seed({
      total_memories_extracted: 10,
      l0_conversations_count: 3,
      memories_since_last_persona: 4,
    });

    await mgr.recalibrate({ totalMemoriesExtracted: 42, l0ConversationsCount: 25 });

    const cp = await mgr.read();
    expect(cp.total_memories_extracted).toBe(42);
    expect(cp.l0_conversations_count).toBe(25);
    // Persona counter is NOT raised: firing late is safer than firing early.
    expect(cp.memories_since_last_persona).toBe(4);
  });

  it("resets counters to zero when the store was fully cleaned", async () => {
    await seed({
      total_memories_extracted: 50,
      l0_conversations_count: 30,
      memories_since_last_persona: 10,
    });

    await mgr.recalibrate({ totalMemoriesExtracted: 0, l0ConversationsCount: 0 });

    const cp = await mgr.read();
    expect(cp.total_memories_extracted).toBe(0);
    expect(cp.l0_conversations_count).toBe(0);
    expect(cp.memories_since_last_persona).toBe(0);
  });

  it("leaves all other checkpoint fields untouched", async () => {
    await seed({
      total_memories_extracted: 50,
      l0_conversations_count: 30,
      memories_since_last_persona: 10,
      total_processed: 1234,
      scenes_processed: 7,
      last_persona_time: "2026-06-01T00:00:00.000Z",
      request_persona_update: true,
      persona_update_reason: "threshold",
      runner_states: {
        "session-a": { last_captured_timestamp: 111, last_l1_cursor: 222, last_scene_name: "work" },
      },
      pipeline_states: {
        "session-a": {
          conversation_count: 3,
          last_extraction_time: "2026-06-02T00:00:00.000Z",
          last_extraction_updated_time: "2026-06-02T01:00:00.000Z",
          last_active_time: 333,
          l2_pending_l1_count: 1,
          warmup_threshold: 2,
          l2_last_extraction_time: "2026-06-03T00:00:00.000Z",
        },
      },
    });

    await mgr.recalibrate({ totalMemoriesExtracted: 42, l0ConversationsCount: 25 });

    const cp = await mgr.read();
    expect(cp.total_processed).toBe(1234);
    expect(cp.scenes_processed).toBe(7);
    expect(cp.last_persona_time).toBe("2026-06-01T00:00:00.000Z");
    expect(cp.request_persona_update).toBe(true);
    expect(cp.persona_update_reason).toBe("threshold");
    expect(cp.runner_states["session-a"]).toEqual({
      last_captured_timestamp: 111,
      last_l1_cursor: 222,
      last_scene_name: "work",
    });
    expect(cp.pipeline_states["session-a"].conversation_count).toBe(3);
    expect(cp.pipeline_states["session-a"].warmup_threshold).toBe(2);
  });

  it("creates the checkpoint file from defaults when none exists yet", async () => {
    await mgr.recalibrate({ totalMemoriesExtracted: 42, l0ConversationsCount: 25 });

    const cp = await mgr.read();
    expect(cp.total_memories_extracted).toBe(42);
    expect(cp.l0_conversations_count).toBe(25);
    expect(cp.memories_since_last_persona).toBe(0);
  });
});
