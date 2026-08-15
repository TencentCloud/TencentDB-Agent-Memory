/**
 * Tests for CheckpointManager counter-drift fix (issue #157).
 *
 * These tests cover the "red phase" of TDD: they assert the existence and
 * correctness of `decrementCounters`, `recalculateCounters`, and
 * `removePipelineState` methods on CheckpointManager. None of these methods
 * exist yet — the tests are expected to FAIL until the implementation lands.
 *
 * Drift problem being solved:
 *   Counters (total_processed, l0_conversations_count, total_memories_extracted,
 *   memories_since_last_persona, scenes_processed) only ever increment. After
 *   cleanup operations (memory-cleaner, manual JSONL pruning, pipeline-state
 *   deletion, session reset) the counters permanently overestimate actual data,
 *   causing downstream logic (persona trigger, L2 corruption check, backup
 *   naming) to drift from reality.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { CheckpointManager } from "./checkpoint.js";

// ============================
// Test harness
// ============================

async function makeTempDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cp-test-"));
  // CheckpointManager expects <dataDir>/.metadata/recall_checkpoint.json
  return dir;
}

async function cleanupDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

describe("CheckpointManager — counter drift fix (#157)", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
  });

  afterEach(async () => {
    await cleanupDir(dataDir);
  });

  // ============================================================
  // decrementCounters
  // ============================================================

  describe("decrementCounters", () => {
    it("decrements total_processed by the given delta", async () => {
      const cm = new CheckpointManager(dataDir);
      // Seed: simulate 10 messages captured
      await cm.captureAtomically("sess-a", 0, async () => ({
        maxTimestamp: 1000,
        messageCount: 10,
      }));

      await cm.decrementCounters({ total_processed: 3 });

      const cp = await cm.read();
      expect(cp.total_processed).toBe(7);
    });

    it("decrements l0_conversations_count", async () => {
      const cm = new CheckpointManager(dataDir);
      await cm.captureAtomically("sess-a", 0, async () => ({
        maxTimestamp: 1000,
        messageCount: 5,
      }));
      await cm.captureAtomically("sess-a", 0, async () => ({
        maxTimestamp: 2000,
        messageCount: 5,
      }));
      // Two captures → l0_conversations_count = 2
      expect((await cm.read()).l0_conversations_count).toBe(2);

      // Memory-cleaner removed 1 conversation file
      await cm.decrementCounters({ l0_conversations_count: 1 });

      const cp = await cm.read();
      expect(cp.l0_conversations_count).toBe(1);
    });

    it("decrements total_memories_extracted and memories_since_last_persona", async () => {
      const cm = new CheckpointManager(dataDir);
      await cm.markL1ExtractionComplete("sess-a", 10);

      // Cleaner removed 4 L1 records
      await cm.decrementCounters({
        total_memories_extracted: 4,
        memories_since_last_persona: 4,
      });

      const cp = await cm.read();
      expect(cp.total_memories_extracted).toBe(6);
      expect(cp.memories_since_last_persona).toBe(6);
    });

    it("decrements scenes_processed", async () => {
      const cm = new CheckpointManager(dataDir);
      await cm.incrementScenesProcessed();
      await cm.incrementScenesProcessed();
      await cm.incrementScenesProcessed();
      expect((await cm.read()).scenes_processed).toBe(3);

      await cm.decrementCounters({ scenes_processed: 2 });

      expect((await cm.read()).scenes_processed).toBe(1);
    });

    it("floors counters at 0 and warns on over-decrement", async () => {
      const warnings: string[] = [];
      const cm = new CheckpointManager(dataDir, {
        info() {},
        warn: (msg) => warnings.push(msg),
      });
      await cm.markL1ExtractionComplete("sess-a", 5);

      // Decrement by more than what exists
      await cm.decrementCounters({
        total_memories_extracted: 100,
        memories_since_last_persona: 100,
        total_processed: 100,
        l0_conversations_count: 100,
        scenes_processed: 100,
      });

      const cp = await cm.read();
      expect(cp.total_memories_extracted).toBe(0);
      expect(cp.memories_since_last_persona).toBe(0);
      expect(cp.total_processed).toBe(0);
      expect(cp.l0_conversations_count).toBe(0);
      expect(cp.scenes_processed).toBe(0);
      // Over-decrement should be surfaced via warn (one per clamped field)
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.some((w) => w.includes("total_memories_extracted"))).toBe(true);
    });

    it("does not warn when decrement stays above 0", async () => {
      const warnings: string[] = [];
      const cm = new CheckpointManager(dataDir, {
        info() {},
        warn: (msg) => warnings.push(msg),
      });
      await cm.markL1ExtractionComplete("sess-a", 10);

      await cm.decrementCounters({ total_memories_extracted: 3 });

      expect((await cm.read()).total_memories_extracted).toBe(7);
      expect(warnings).toHaveLength(0);
    });

    it("is a no-op when delta is 0 or fields are omitted", async () => {
      const cm = new CheckpointManager(dataDir);
      await cm.markL1ExtractionComplete("sess-a", 5);

      await cm.decrementCounters({});

      const cp = await cm.read();
      expect(cp.total_memories_extracted).toBe(5);
    });

    it("is atomic — concurrent decrements do not lose updates", async () => {
      const cm = new CheckpointManager(dataDir);
      // Seed 100 memories
      await cm.markL1ExtractionComplete("sess-a", 100);

      // Fire 10 concurrent decrements of 5 each = 50 total
      const decrements = Array.from({ length: 10 }, () =>
        cm.decrementCounters({ total_memories_extracted: 5 }),
      );
      await Promise.all(decrements);

      const cp = await cm.read();
      // Must be exactly 50 — no lost updates despite concurrent read-modify-write
      expect(cp.total_memories_extracted).toBe(50);
    });
  });

  // ============================================================
  // recalculateCounters
  // ============================================================

  describe("recalculateCounters", () => {
    it("sets counters to the provided authoritative values", async () => {
      const cm = new CheckpointManager(dataDir);
      // Drifted state: checkpoint thinks there are 100 memories but only 30 exist
      await cm.markL1ExtractionComplete("sess-a", 100);

      // Reconcile with actual count from vector store
      await cm.recalculateCounters({
        total_memories_extracted: 30,
        memories_since_last_persona: 30,
      });

      const cp = await cm.read();
      expect(cp.total_memories_extracted).toBe(30);
      expect(cp.memories_since_last_persona).toBe(30);
    });

    it("only updates provided fields — leaves others unchanged", async () => {
      const cm = new CheckpointManager(dataDir);
      await cm.captureAtomically("sess-a", 0, async () => ({
        maxTimestamp: 1000,
        messageCount: 10,
      }));
      await cm.markL1ExtractionComplete("sess-a", 5);
      await cm.incrementScenesProcessed();

      // Recalculate only total_memories_extracted
      await cm.recalculateCounters({ total_memories_extracted: 3 });

      const cp = await cm.read();
      expect(cp.total_memories_extracted).toBe(3);
      // Untouched fields keep their original values
      expect(cp.total_processed).toBe(10);
      expect(cp.l0_conversations_count).toBe(1);
      expect(cp.scenes_processed).toBe(1);
    });

    it("supports full reconciliation across all counters", async () => {
      const cm = new CheckpointManager(dataDir);
      // Seed drifted state
      await cm.captureAtomically("sess-a", 0, async () => ({
        maxTimestamp: 1000,
        messageCount: 50,
      }));
      await cm.markL1ExtractionComplete("sess-a", 20);
      await cm.incrementScenesProcessed();

      // Bulk reconciliation after memory-cleaner run
      await cm.recalculateCounters({
        total_processed: 30,
        l0_conversations_count: 3,
        total_memories_extracted: 12,
        memories_since_last_persona: 12,
        scenes_processed: 2,
      });

      const cp = await cm.read();
      expect(cp.total_processed).toBe(30);
      expect(cp.l0_conversations_count).toBe(3);
      expect(cp.total_memories_extracted).toBe(12);
      expect(cp.memories_since_last_persona).toBe(12);
      expect(cp.scenes_processed).toBe(2);
    });

    it("is atomic — concurrent recalculate + increment do not corrupt", async () => {
      const cm = new CheckpointManager(dataDir);
      await cm.markL1ExtractionComplete("sess-a", 10);

      // Interleave recalculate with increments
      await Promise.all([
        cm.recalculateCounters({ total_memories_extracted: 5 }),
        cm.markL1ExtractionComplete("sess-a", 3),
        cm.recalculateCounters({ memories_since_last_persona: 2 }),
      ]);

      const cp = await cm.read();
      // recalculate(total_memories_extracted=5) and markL1(+3) both touch
      // total_memories_extracted. Either ordering is acceptable, but the
      // result must be one of {5, 8} — never a corrupted/garbage value.
      expect([5, 8]).toContain(cp.total_memories_extracted);
    });

    it("throws RangeError on negative input", async () => {
      const cm = new CheckpointManager(dataDir);
      await expect(cm.recalculateCounters({ total_processed: -1 })).rejects.toThrow(RangeError);
      await expect(cm.recalculateCounters({ total_memories_extracted: -5 })).rejects.toThrow(RangeError);
      // Original state untouched after a throw
      const cp = await cm.read();
      expect(cp.total_processed).toBe(0);
    });

    it("accepts 0 (store legitimately empty)", async () => {
      const cm = new CheckpointManager(dataDir);
      await cm.markL1ExtractionComplete("sess-a", 50);

      await cm.recalculateCounters({
        total_memories_extracted: 0,
        memories_since_last_persona: 0,
      });

      const cp = await cm.read();
      expect(cp.total_memories_extracted).toBe(0);
      expect(cp.memories_since_last_persona).toBe(0);
    });

    it("warns when recalculate decreases a value (drift detected)", async () => {
      const warnings: string[] = [];
      const cm = new CheckpointManager(dataDir, {
        info() {},
        warn: (msg) => warnings.push(msg),
      });
      await cm.markL1ExtractionComplete("sess-a", 100);

      await cm.recalculateCounters({ total_memories_extracted: 30 });

      // Drift detected: 100 → 30
      expect(warnings.some((w) => w.includes("total_memories_extracted") && w.includes("drift"))).toBe(true);
    });

    it("does not warn when recalculate increases or keeps a value", async () => {
      const warnings: string[] = [];
      const cm = new CheckpointManager(dataDir, {
        info() {},
        warn: (msg) => warnings.push(msg),
      });
      await cm.markL1ExtractionComplete("sess-a", 10);

      // Same value — no drift
      await cm.recalculateCounters({ total_memories_extracted: 10 });
      expect(warnings).toHaveLength(0);

      // Higher value — no drift (e.g. missed increments being corrected up)
      await cm.recalculateCounters({ total_memories_extracted: 15 });
      expect(warnings).toHaveLength(0);
    });
  });

  // ============================================================
  // removeRunnerState — drift path: session reset (runner-owned state)
  // ============================================================

  describe("removeRunnerState", () => {
    it("removes a session's runner state entry", async () => {
      const cm = new CheckpointManager(dataDir);
      await cm.captureAtomically("sess-a", 0, async () => ({
        maxTimestamp: 5000,
        messageCount: 3,
      }));

      expect((await cm.read()).runner_states["sess-a"]).toBeDefined();

      await cm.removeRunnerState("sess-a");

      const cp = await cm.read();
      expect(cp.runner_states["sess-a"]).toBeUndefined();
    });

    it("is a no-op for unknown session keys", async () => {
      const cm = new CheckpointManager(dataDir);
      await cm.removeRunnerState("never-existed");
      expect(Object.keys((await cm.read()).runner_states)).toHaveLength(0);
    });

    it("does not touch pipeline_states for the same session", async () => {
      const cm = new CheckpointManager(dataDir);
      await cm.captureAtomically("sess-a", 0, async () => ({
        maxTimestamp: 1000,
        messageCount: 1,
      }));
      await cm.mergePipelineStates({
        "sess-a": {
          conversation_count: 1,
          last_extraction_time: "",
          last_extraction_updated_time: "",
          last_active_time: Date.now(),
          l2_pending_l1_count: 0,
          warmup_threshold: 1,
          l2_last_extraction_time: "",
        },
      });

      await cm.removeRunnerState("sess-a");

      const cp = await cm.read();
      expect(cp.runner_states["sess-a"]).toBeUndefined();
      // Pipeline state must survive runner-state removal
      expect(cp.pipeline_states["sess-a"]).toBeDefined();
      expect(cp.pipeline_states["sess-a"]!.conversation_count).toBe(1);
    });

    it("resets L0 capture cursor — next capture re-pulls from start", async () => {
      const cm = new CheckpointManager(dataDir);
      await cm.captureAtomically("sess-a", 0, async () => ({
        maxTimestamp: 9999,
        messageCount: 5,
      }));
      expect((await cm.read()).runner_states["sess-a"]!.last_captured_timestamp).toBe(9999);

      await cm.removeRunnerState("sess-a");

      // After removal, a new capture starts fresh (cursor absent → treated as 0)
      await cm.captureAtomically("sess-a", 0, async (afterTs) => {
        expect(afterTs).toBe(0); // cursor reset → full re-pull
        return { maxTimestamp: 100, messageCount: 1 };
      });
    });
  });

  // ============================================================
  // removePipelineState — drift path: "deleting pipeline state"
  // ============================================================

  describe("removePipelineState", () => {
    it("removes a session's pipeline state entry", async () => {
      const cm = new CheckpointManager(dataDir);
      await cm.mergePipelineStates({
        "sess-a": {
          conversation_count: 3,
          last_extraction_time: "2026-07-19T00:00:00.000Z",
          last_extraction_updated_time: "2026-07-19T00:00:00.000Z",
          last_active_time: Date.now(),
          l2_pending_l1_count: 0,
          warmup_threshold: 0,
          l2_last_extraction_time: "",
        },
      });

      expect(Object.keys((await cm.read()).pipeline_states)).toContain("sess-a");

      await cm.removePipelineState("sess-a");

      const cp = await cm.read();
      expect(cp.pipeline_states["sess-a"]).toBeUndefined();
    });

    it("is a no-op for unknown session keys", async () => {
      const cm = new CheckpointManager(dataDir);
      // Should not throw
      await cm.removePipelineState("never-existed");
      expect(Object.keys((await cm.read()).pipeline_states)).toHaveLength(0);
    });

    it("does not touch runner_states for the same session", async () => {
      const cm = new CheckpointManager(dataDir);
      // Seed runner state via captureAtomically (writes runner_states)
      await cm.captureAtomically("sess-a", 0, async () => ({
        maxTimestamp: 1000,
        messageCount: 1,
      }));
      // Seed pipeline state
      await cm.mergePipelineStates({
        "sess-a": {
          conversation_count: 1,
          last_extraction_time: "",
          last_extraction_updated_time: "",
          last_active_time: Date.now(),
          l2_pending_l1_count: 0,
          warmup_threshold: 1,
          l2_last_extraction_time: "",
        },
      });

      await cm.removePipelineState("sess-a");

      const cp = await cm.read();
      expect(cp.pipeline_states["sess-a"]).toBeUndefined();
      // Runner cursor must survive pipeline-state removal
      expect(cp.runner_states["sess-a"]).toBeDefined();
      expect(cp.runner_states["sess-a"].last_captured_timestamp).toBe(1000);
    });
  });

  // ============================================================
  // End-to-end drift scenarios (acceptance criteria #2 & #3)
  // ============================================================

  describe("cleanup drift scenarios", () => {
    it("memory-cleaner removes L1 records → counters reflect actual data", async () => {
      const cm = new CheckpointManager(dataDir);
      // Simulate normal pipeline progress
      await cm.captureAtomically("sess-a", 0, async () => ({
        maxTimestamp: 1000,
        messageCount: 10,
      }));
      await cm.markL1ExtractionComplete("sess-a", 8);

      // memory-cleaner deletes 5 L1 records from the vector store
      // (LocalMemoryCleaner.runOnce does NOT currently update checkpoint)
      const deletedL1Count = 5;
      await cm.decrementCounters({
        total_memories_extracted: deletedL1Count,
        memories_since_last_persona: deletedL1Count,
      });

      const cp = await cm.read();
      // Counters now match reality: 8 - 5 = 3 memories remain
      expect(cp.total_memories_extracted).toBe(3);
      expect(cp.memories_since_last_persona).toBe(3);
    });

    it("manual JSONL pruning → l0_conversations_count matches file count", async () => {
      const cm = new CheckpointManager(dataDir);
      // 5 conversations captured
      for (let i = 0; i < 5; i++) {
        await cm.captureAtomically("sess-a", i * 1000, async () => ({
          maxTimestamp: (i + 1) * 1000,
          messageCount: 2,
        }));
      }
      expect((await cm.read()).l0_conversations_count).toBe(5);

      // Admin manually prunes 2 old JSONL files
      await cm.decrementCounters({ l0_conversations_count: 2 });

      expect((await cm.read()).l0_conversations_count).toBe(3);
    });

    it("pipeline-state deletion → session no longer tracked in pipeline_states", async () => {
      const cm = new CheckpointManager(dataDir);
      await cm.mergePipelineStates({
        "test-sess": {
          conversation_count: 5,
          last_extraction_time: "",
          last_extraction_updated_time: "",
          last_active_time: Date.now(),
          l2_pending_l1_count: 5,
          warmup_threshold: 1,
          l2_last_extraction_time: "",
        },
        "real-sess": {
          conversation_count: 2,
          last_extraction_time: "",
          last_extraction_updated_time: "",
          last_active_time: Date.now(),
          l2_pending_l1_count: 0,
          warmup_threshold: 1,
          l2_last_extraction_time: "",
        },
      });

      // Delete test pipeline state
      await cm.removePipelineState("test-sess");

      const cp = await cm.read();
      expect(Object.keys(cp.pipeline_states)).toEqual(["real-sess"]);
    });

    it("full reconciliation after bulk cleanup → checkpoint matches ground truth", async () => {
      const cm = new CheckpointManager(dataDir);
      // Long-running system with drifted counters
      await cm.captureAtomically("sess-a", 0, async () => ({
        maxTimestamp: 1000,
        messageCount: 1000,
      }));
      await cm.markL1ExtractionComplete("sess-a", 500);
      for (let i = 0; i < 10; i++) await cm.incrementScenesProcessed();

      // After major cleanup, vector store reports actual counts
      const actualL0 = 12;
      const actualL1 = 87;
      const actualScenes = 3;

      await cm.recalculateCounters({
        total_processed: actualL0,
        l0_conversations_count: actualL0,
        total_memories_extracted: actualL1,
        memories_since_last_persona: actualL1,
        scenes_processed: actualScenes,
      });

      const cp = await cm.read();
      expect(cp.total_processed).toBe(actualL0);
      expect(cp.l0_conversations_count).toBe(actualL0);
      expect(cp.total_memories_extracted).toBe(actualL1);
      expect(cp.memories_since_last_persona).toBe(actualL1);
      expect(cp.scenes_processed).toBe(actualScenes);
    });
  });
});
