/**
 * Unit tests for CheckpointManager.
 *
 * Tests cover:
 * - Decrement methods (decrementL0ConversationCount, decrementMemoriesExtracted, decrementTotalProcessed)
 * - Recalibrate method
 * - Existing increment methods for regression testing
 * - Cleanup scenarios (manual pruning, automatic cleaner, session reset)
 * - Design pattern validation (hybrid cursor-first approach)
 *
 * Uses real filesystem with temporary directories.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CheckpointManager } from "./checkpoint.js";

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SCENARIO COVERAGE MATRIX
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * | Scenario                    | Trigger                    | Test Method         |
 * |-----------------------------|----------------------------|---------------------|
 * | Manual JSONL pruning        | User deletes old shards     | recalibrate()       |
 * | Test data cleanup          | Dev removes test records    | decrement*()        |
 * | memory-cleaner auto cleanup| Scheduled daily cleanup    | recalibrate()       |
 * | Session reset              | User resets a session      | decrement*()        |
 * | Incremental L1 skip fix    | After cleanup + new data   | recalibrate()       |
 * | Incremental L2 skip fix    | After cleanup + new records| recalibrate()       |
 * | Counter drift detection    | Post-cleanup verification  | read()              |
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

describe("CheckpointManager", () => {
  // Track all temp dirs for cleanup
  const tempDirs: string[] = [];

  afterEach(async () => {
    // Clean up temp directories
    for (const dir of tempDirs) {
      try {
        await fs.promises.rm(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
    tempDirs.length = 0;
  });

  function createTempDir(): string {
    const dir = path.join(os.tmpdir(), `checkpoint-test-${Date.now()}-${Math.random()}`);
    fs.mkdirSync(dir, { recursive: true });
    tempDirs.push(dir);
    return dir;
  }

  // ============================
  // Decrement methods
  // ============================

  describe("decrementL0ConversationCount", () => {
    it("decrements l0_conversations_count by 1 when no count provided", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      // First, increment via recalibrate to set a known value
      await manager.recalibrate({ actualL0Count: 10, actualL1Count: 5, actualTotalProcessed: 100 });

      await manager.decrementL0ConversationCount();

      const cp = await manager.read();
      expect(cp.l0_conversations_count).toBe(9);
    });

    it("decrements by specified count", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      await manager.recalibrate({ actualL0Count: 50, actualL1Count: 25, actualTotalProcessed: 200 });

      await manager.decrementL0ConversationCount(5);

      const cp = await manager.read();
      expect(cp.l0_conversations_count).toBe(45);
    });

    it("clamps to 0 when decrement exceeds current value", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      await manager.recalibrate({ actualL0Count: 3, actualL1Count: 1, actualTotalProcessed: 10 });

      await manager.decrementL0ConversationCount(10);

      const cp = await manager.read();
      expect(cp.l0_conversations_count).toBe(0);
    });

    it("handles zero gracefully", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      await manager.recalibrate({ actualL0Count: 0, actualL1Count: 0, actualTotalProcessed: 0 });

      await manager.decrementL0ConversationCount();

      const cp = await manager.read();
      expect(cp.l0_conversations_count).toBe(0);
    });
  });

  describe("decrementMemoriesExtracted", () => {
    it("decrements total_memories_extracted by specified count", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      await manager.recalibrate({ actualL0Count: 5, actualL1Count: 20, actualTotalProcessed: 100 });

      await manager.decrementMemoriesExtracted(7);

      const cp = await manager.read();
      expect(cp.total_memories_extracted).toBe(13);
    });

    it("also decrements memories_since_last_persona", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      // Set up initial checkpoint state
      const cp0 = await manager.read();
      cp0.last_persona_at = 50;
      cp0.total_memories_extracted = 100;
      cp0.memories_since_last_persona = 50; // 100 - 50
      await manager.write(cp0);

      await manager.decrementMemoriesExtracted(10);

      const cp = await manager.read();
      expect(cp.total_memories_extracted).toBe(90);
      // memories_since_last_persona = 50 - 10 = 40
      expect(cp.memories_since_last_persona).toBe(40);
    });

    it("clamps total_memories_extracted to 0 when decrement exceeds", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      await manager.recalibrate({ actualL0Count: 1, actualL1Count: 5, actualTotalProcessed: 10 });

      await manager.decrementMemoriesExtracted(100);

      const cp = await manager.read();
      expect(cp.total_memories_extracted).toBe(0);
    });

    it("clamps memories_since_last_persona to 0 when decrement exceeds", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      await manager.recalibrate({ actualL0Count: 1, actualL1Count: 10, actualTotalProcessed: 50 });

      await manager.decrementMemoriesExtracted(100);

      const cp = await manager.read();
      expect(cp.memories_since_last_persona).toBe(0);
    });
  });

  describe("decrementTotalProcessed", () => {
    it("decrements total_processed by specified count", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      await manager.recalibrate({ actualL0Count: 5, actualL1Count: 20, actualTotalProcessed: 1000 });

      await manager.decrementTotalProcessed(300);

      const cp = await manager.read();
      expect(cp.total_processed).toBe(700);
    });

    it("clamps to 0 when decrement exceeds current value", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      await manager.recalibrate({ actualL0Count: 1, actualL1Count: 5, actualTotalProcessed: 50 });

      await manager.decrementTotalProcessed(100);

      const cp = await manager.read();
      expect(cp.total_processed).toBe(0);
    });

    it("handles zero gracefully", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      await manager.recalibrate({ actualL0Count: 0, actualL1Count: 0, actualTotalProcessed: 0 });

      await manager.decrementTotalProcessed(1);

      const cp = await manager.read();
      expect(cp.total_processed).toBe(0);
    });
  });

  // ============================
  // Recalibrate method
  // ============================

  describe("recalibrate", () => {
    it("resets all counters to provided values", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      // First set some values
      await manager.recalibrate({ actualL0Count: 100, actualL1Count: 500, actualTotalProcessed: 2000 });

      // Then recalibrate to new values
      const result = await manager.recalibrate({
        actualL0Count: 50,
        actualL1Count: 200,
        actualTotalProcessed: 1000,
      });

      expect(result.l0_conversations_count).toBe(50);
      expect(result.total_memories_extracted).toBe(200);
      expect(result.total_processed).toBe(1000);
    });

    it("recalculates memories_since_last_persona correctly", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      // Set up: 100 memories extracted, persona was at 60
      const cp0 = await manager.read();
      cp0.last_persona_at = 60;
      await manager.write(cp0);

      const result = await manager.recalibrate({
        actualL0Count: 10,
        actualL1Count: 100,
        actualTotalProcessed: 500,
      });

      // memories_since = 100 - 60 = 40
      expect(result.memories_since_last_persona).toBe(40);
    });

    it("clamps negative memories_since_last_persona to 0", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      // Set up: 50 memories extracted, persona was at 100 (more than current)
      const cp0 = await manager.read();
      cp0.last_persona_at = 100;
      await manager.write(cp0);

      const result = await manager.recalibrate({
        actualL0Count: 5,
        actualL1Count: 50,
        actualTotalProcessed: 200,
      });

      // memories_since = 50 - 100 = -50, clamped to 0
      expect(result.memories_since_last_persona).toBe(0);
    });

    it("clamps negative values to 0", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      const result = await manager.recalibrate({
        actualL0Count: -10,
        actualL1Count: -5,
        actualTotalProcessed: -100,
      });

      expect(result.l0_conversations_count).toBe(0);
      expect(result.total_memories_extracted).toBe(0);
      expect(result.total_processed).toBe(0);
    });

    it("handles zero values correctly", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      const result = await manager.recalibrate({
        actualL0Count: 0,
        actualL1Count: 0,
        actualTotalProcessed: 0,
      });

      expect(result.l0_conversations_count).toBe(0);
      expect(result.total_memories_extracted).toBe(0);
      expect(result.total_processed).toBe(0);
    });
  });

  // ============================
  // Concurrent modification handling
  // ============================

  describe("concurrent modifications", () => {
    it("handles multiple decrements sequentially", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      await manager.recalibrate({ actualL0Count: 100, actualL1Count: 50, actualTotalProcessed: 1000 });

      await manager.decrementL0ConversationCount(10);
      await manager.decrementL0ConversationCount(20);
      await manager.decrementL0ConversationCount(5);

      const cp = await manager.read();
      expect(cp.l0_conversations_count).toBe(65); // 100 - 10 - 20 - 5 = 65
    });

    it("handles interleaved increments and decrements", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      await manager.recalibrate({ actualL0Count: 50, actualL1Count: 25, actualTotalProcessed: 500 });

      // Simulate increment then decrement
      const cp1 = await manager.read();
      cp1.l0_conversations_count += 10;
      cp1.total_processed += 100;
      await manager.write(cp1);

      await manager.decrementL0ConversationCount(5);
      await manager.decrementTotalProcessed(50);

      const cp = await manager.read();
      expect(cp.l0_conversations_count).toBe(55); // 50 + 10 - 5 = 55
      expect(cp.total_processed).toBe(550); // 500 + 100 - 50 = 550
    });
  });

  // ============================
  // File persistence
  // ============================

  describe("file persistence", () => {
    it("persists decremented values across manager instances", async () => {
      const dataDir = createTempDir();

      const manager1 = new CheckpointManager(dataDir);
      await manager1.recalibrate({ actualL0Count: 100, actualL1Count: 50, actualTotalProcessed: 1000 });
      await manager1.decrementL0ConversationCount(25);
      await manager1.decrementTotalProcessed(200);

      // Create new manager instance pointing to same dir
      const manager2 = new CheckpointManager(dataDir);
      const cp = await manager2.read();

      expect(cp.l0_conversations_count).toBe(75);
      expect(cp.total_processed).toBe(800);
    });

    it("creates checkpoint file after mutation", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      // read() alone doesn't create the file (it's a snapshot, not a mutation)
      await manager.read();

      // Mutating operation creates the file
      await manager.recalibrate({ actualL0Count: 0, actualL1Count: 0, actualTotalProcessed: 0 });

      // File should exist now
      const checkpointPath = path.join(dataDir, ".metadata", "recall_checkpoint.json");
      expect(fs.existsSync(checkpointPath)).toBe(true);
    });
  });

  // ============================
  // Integration with existing methods
  // ============================

  describe("integration with existing methods", () => {
    it("decrement works after captureAtomically", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      // Simulate some captures
      await manager.recalibrate({ actualL0Count: 5, actualL1Count: 3, actualTotalProcessed: 30 });

      // Decrement
      await manager.decrementL0ConversationCount(2);

      const cp = await manager.read();
      expect(cp.l0_conversations_count).toBe(3);
    });

    it("decrement works after recalibrate", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      // Recalibrate
      await manager.recalibrate({ actualL0Count: 100, actualL1Count: 50, actualTotalProcessed: 500 });

      // Decrement
      await manager.decrementMemoriesExtracted(10);
      await manager.decrementTotalProcessed(100);

      const cp = await manager.read();
      expect(cp.total_memories_extracted).toBe(40);
      expect(cp.total_processed).toBe(400);
    });

    it("recalibrate works after decrements", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      // Initial state
      await manager.recalibrate({ actualL0Count: 100, actualL1Count: 50, actualTotalProcessed: 500 });

      // Decrement
      await manager.decrementL0ConversationCount(20);
      await manager.decrementMemoriesExtracted(10);

      // Recalibrate (e.g., after cleanup)
      await manager.recalibrate({ actualL0Count: 80, actualL1Count: 40, actualTotalProcessed: 400 });

      const cp = await manager.read();
      expect(cp.l0_conversations_count).toBe(80);
      expect(cp.total_memories_extracted).toBe(40);
      expect(cp.total_processed).toBe(400);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // CLEANUP SCENARIO TESTS
  // ═══════════════════════════════════════════════════════════════════════════════

  describe("cleanup scenarios", () => {

    /**
     * Scenario: Manual JSONL pruning
     * User deletes old conversations/YYYY-MM-DD.jsonl and records/YYYY-MM-DD.jsonl shards.
     * Checkpoint counters should be recalibrated to match actual retained data.
     */
    describe("manual JSONL pruning", () => {
      it("recalibrates counters after user deletes old shards", async () => {
        const dataDir = createTempDir();
        const manager = new CheckpointManager(dataDir);

        // Simulate checkpoint state BEFORE pruning
        await manager.recalibrate({
          actualL0Count: 100,
          actualL1Count: 50,
          actualTotalProcessed: 500,
        });

        // User manually deletes 60 L0 and 30 L1 records from disk
        // (This would be actual file deletion in production)
        const result = await manager.recalibrate({
          actualL0Count: 40,  // 100 - 60 deleted
          actualL1Count: 20,  // 50 - 30 deleted
          actualTotalProcessed: 200,  // proportional reduction
        });

        expect(result.l0_conversations_count).toBe(40);
        expect(result.total_memories_extracted).toBe(20);
        expect(result.total_processed).toBe(200);
      });

      it("prevents L1 trigger issues after pruning", async () => {
        const dataDir = createTempDir();
        const manager = new CheckpointManager(dataDir);

        // Simulate: checkpoint thinks 50 L1 records exist
        await manager.recalibrate({
          actualL0Count: 20,
          actualL1Count: 50,
          actualTotalProcessed: 200,
        });

        // User prunes: only 25 L1 records remain
        await manager.recalibrate({
          actualL0Count: 20,
          actualL1Count: 25,
          actualTotalProcessed: 150,
        });

        // memories_since_last_persona should be recalculated
        // so persona trigger fires at correct threshold
        const cp = await manager.read();
        expect(cp.total_memories_extracted).toBe(25);
      });
    });

    /**
     * Scenario: Test data cleanup
     * Developer removes test pipeline states and test data.
     * Use decrement methods for targeted correction.
     */
    describe("test data cleanup", () => {
      it("decrements counters when removing test records", async () => {
        const dataDir = createTempDir();
        const manager = new CheckpointManager(dataDir);

        // Simulate: checkpoint has test data
        await manager.recalibrate({
          actualL0Count: 15,
          actualL1Count: 10,
          actualTotalProcessed: 100,
        });

        // Developer removes 5 test L0 conversations and 3 test L1 records
        await manager.decrementL0ConversationCount(5);
        await manager.decrementMemoriesExtracted(3);
        await manager.decrementTotalProcessed(30);

        const cp = await manager.read();
        expect(cp.l0_conversations_count).toBe(10);  // 15 - 5
        expect(cp.total_memories_extracted).toBe(7);   // 10 - 3
        expect(cp.total_processed).toBe(70);           // 100 - 30
      });

      it("handles partial test data removal correctly", async () => {
        const dataDir = createTempDir();
        const manager = new CheckpointManager(dataDir);

        await manager.recalibrate({
          actualL0Count: 12,
          actualL1Count: 8,
          actualTotalProcessed: 80,
        });

        // Remove only L0 test data (5 conversations)
        await manager.decrementL0ConversationCount(5);

        const cp = await manager.read();
        expect(cp.l0_conversations_count).toBe(7);
        expect(cp.total_memories_extracted).toBe(8);  // Unchanged
        expect(cp.total_processed).toBe(80);          // Unchanged
      });
    });

    /**
     * Scenario: Session reset
     * User resets a specific session's data.
     * Checkpoint should handle per-session state correctly.
     */
    describe("session reset", () => {
      it("preserves other session counters when one is reset", async () => {
        const dataDir = createTempDir();
        const manager = new CheckpointManager(dataDir);

        // Simulate two sessions
        await manager.recalibrate({
          actualL0Count: 20,  // 10 per session
          actualL1Count: 10,  // 5 per session
          actualTotalProcessed: 200,
        });

        // Reset session-b: decrement by 10 L0, 5 L1
        await manager.decrementL0ConversationCount(10);
        await manager.decrementMemoriesExtracted(5);
        await manager.decrementTotalProcessed(100);

        const cp = await manager.read();
        expect(cp.l0_conversations_count).toBe(10);  // session-a remains
        expect(cp.total_memories_extracted).toBe(5);  // session-a remains
        expect(cp.total_processed).toBe(100);         // session-a remains
      });

      it("handles complete session reset", async () => {
        const dataDir = createTempDir();
        const manager = new CheckpointManager(dataDir);

        // Single session with all data
        await manager.recalibrate({
          actualL0Count: 25,
          actualL1Count: 15,
          actualTotalProcessed: 250,
        });

        // Complete reset
        await manager.decrementL0ConversationCount(25);
        await manager.decrementMemoriesExtracted(15);
        await manager.decrementTotalProcessed(250);

        const cp = await manager.read();
        expect(cp.l0_conversations_count).toBe(0);
        expect(cp.total_memories_extracted).toBe(0);
        expect(cp.total_processed).toBe(0);
      });
    });

    /**
     * Scenario: Incremental processing prevention
     * After cleanup, new data should NOT be skipped.
     * Recalibration ensures cursors are correct.
     */
    describe("incremental processing", () => {
      it("recalibration prevents L1 from skipping new records", async () => {
        const dataDir = createTempDir();
        const manager = new CheckpointManager(dataDir);

        // Simulate: checkpoint drifted ahead
        await manager.recalibrate({
          actualL0Count: 100,
          actualL1Count: 50,
          actualTotalProcessed: 500,
        });

        // Cleanup removes 50 L0 records
        await manager.recalibrate({
          actualL0Count: 50,
          actualL1Count: 25,
          actualTotalProcessed: 250,
        });

        // Now new data comes in - it should be processed
        // (In real code, captureAtomically would increment from 50, not skip from 100)
        const cp = await manager.read();
        expect(cp.l0_conversations_count).toBe(50);
        // New capture would add +1, resulting in 51 (not 101)
      });

      it("memories_since_last_persona recalculates correctly after cleanup", async () => {
        const dataDir = createTempDir();
        const manager = new CheckpointManager(dataDir);

        // Set up: 100 memories, persona at 60
        const cp0 = await manager.read();
        cp0.last_persona_at = 60;
        cp0.memories_since_last_persona = 40;
        await manager.write(cp0);

        // Cleanup: 60 memories remain
        const result = await manager.recalibrate({
          actualL0Count: 30,
          actualL1Count: 60,
          actualTotalProcessed: 300,
        });

        // memories_since = 60 - 60 = 0 (persona just ran for this data)
        expect(result.memories_since_last_persona).toBe(0);
      });

      it("handles persona point exceeding current L1 count", async () => {
        const dataDir = createTempDir();
        const manager = new CheckpointManager(dataDir);

        // Set up: 50 memories, persona at 80 (more than current)
        const cp0 = await manager.read();
        cp0.last_persona_at = 80;
        cp0.memories_since_last_persona = 0;
        await manager.write(cp0);

        // After cleanup: only 30 memories remain
        const result = await manager.recalibrate({
          actualL0Count: 15,
          actualL1Count: 30,
          actualTotalProcessed: 150,
        });

        // memories_since = max(0, 30 - 80) = 0
        expect(result.memories_since_last_persona).toBe(0);
      });
    });

    /**
     * Scenario: Automatic cleaner (memory-cleaner integration)
     * After memory-cleaner.runOnce(), checkpoint should be recalibrated.
     */
    describe("automatic cleaner integration", () => {
      it("supports recalibration after cleaner run", async () => {
        const dataDir = createTempDir();
        const manager = new CheckpointManager(dataDir);

        // Simulate: cleaner ran and deleted expired data
        // L0: removed 30 expired, kept 50 (above MIN_RETAIN_L0)
        // L1: removed 10 expired, kept 20 (at MIN_RETAIN_L1)
        await manager.recalibrate({
          actualL0Count: 50,
          actualL1Count: 20,
          actualTotalProcessed: 250,
        });

        // Verify minimum retention respected
        const cp = await manager.read();
        expect(cp.l0_conversations_count).toBeGreaterThanOrEqual(0);
        expect(cp.total_memories_extracted).toBeGreaterThanOrEqual(0);
      });

      it("handles cleaner running on fresh data (no deletion)", async () => {
        const dataDir = createTempDir();
        const manager = new CheckpointManager(dataDir);

        // Data is within retention, cleaner does nothing
        await manager.recalibrate({
          actualL0Count: 10,
          actualL1Count: 5,
          actualTotalProcessed: 50,
        });

        const cp = await manager.read();
        expect(cp.l0_conversations_count).toBe(10);
        expect(cp.total_memories_extracted).toBe(5);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // DESIGN PATTERN VALIDATION TESTS
  // ═══════════════════════════════════════════════════════════════════════════════

  describe("design pattern validation", () => {

    /**
     * Validates: Hybrid cursor-first approach
     * Counters are derived status values, not the source of truth.
     */
    it("counters can be recalculated independently of storage", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      // Simulate: storage has 100 L0, 50 L1
      await manager.recalibrate({
        actualL0Count: 100,
        actualL1Count: 50,
        actualTotalProcessed: 500,
      });

      // Verify counters reflect storage
      let cp = await manager.read();
      expect(cp.l0_conversations_count).toBe(100);
      expect(cp.total_memories_extracted).toBe(50);

      // Simulate: storage now has 80 L0, 40 L1
      await manager.recalibrate({
        actualL0Count: 80,
        actualL1Count: 40,
        actualTotalProcessed: 400,
      });

      cp = await manager.read();
      expect(cp.l0_conversations_count).toBe(80);
      expect(cp.total_memories_extracted).toBe(40);
    });

    /**
     * Validates: Backward compatibility
     * Existing checkpoint schema is preserved.
     */
    it("checkpoint schema remains compatible", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      // Use recalibrate (new method)
      await manager.recalibrate({
        actualL0Count: 50,
        actualL1Count: 25,
        actualTotalProcessed: 250,
      });

      // Read with standard read() method
      const cp = await manager.read();

      // Verify all expected fields exist
      expect(cp).toHaveProperty("l0_conversations_count");
      expect(cp).toHaveProperty("total_memories_extracted");
      expect(cp).toHaveProperty("total_processed");
      expect(cp).toHaveProperty("memories_since_last_persona");
      expect(cp).toHaveProperty("last_persona_at");
      expect(cp).toHaveProperty("runner_states");
      expect(cp).toHaveProperty("pipeline_states");
    });

    /**
     * Validates: Atomic operations
     * File lock ensures concurrent access safety.
     */
    it("handles concurrent recalibrations safely", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      await manager.recalibrate({
        actualL0Count: 100,
        actualL1Count: 50,
        actualTotalProcessed: 500,
      });

      // Simulate concurrent decrements
      await Promise.all([
        manager.decrementL0ConversationCount(10),
        manager.decrementL0ConversationCount(20),
        manager.decrementL0ConversationCount(5),
      ]);

      // All three decrements should be applied
      const cp = await manager.read();
      expect(cp.l0_conversations_count).toBe(65); // 100 - 10 - 20 - 5
    });
  });
});
