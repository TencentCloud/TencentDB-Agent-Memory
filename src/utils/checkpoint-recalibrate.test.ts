import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CheckpointManager } from "./checkpoint.js";

describe("CheckpointManager.recalibrate", () => {
  const tmpDirs: string[] = [];

  function createTempDir(): string {
    const dir = path.join(os.tmpdir(), `checkpoint-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tmpDirs) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    tmpDirs.length = 0;
  });

  describe("when counters are in sync", () => {
    it("should not update checkpoint if values match", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      // Initialize checkpoint with known values
      await manager.captureAtomically("session-1", undefined, async () => ({
        maxTimestamp: 1000,
        messageCount: 5,
      }));

      // Verify initial state
      const before = await manager.read();
      expect(before.l0_conversations_count).toBe(1);
      expect(before.total_memories_extracted).toBe(0);

      // Recalibrate with matching counts
      const result = await manager.recalibrate({
        countL0: async () => 1,
        countL1: async () => 0,
      });

      expect(result.l0Count).toBe(1);
      expect(result.l1Count).toBe(0);
      expect(result.updated).toBe(false);
      expect(result.error).toBeUndefined();

      // Verify no change
      const after = await manager.read();
      expect(after.l0_conversations_count).toBe(1);
      expect(after.total_memories_extracted).toBe(0);
    });
  });

  describe("when counters are drifted", () => {
    it("should fix l0_conversations_count drift", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      // Initialize with 10 conversations
      for (let i = 0; i < 10; i++) {
        await manager.captureAtomically("session-1", undefined, async () => ({
          maxTimestamp: 1000 + i,
          messageCount: 1,
        }));
      }

      // Simulate drift: checkpoint says 10, but storage has 7 (after cleanup)
      const result = await manager.recalibrate({
        countL0: async () => 7,
        countL1: async () => 0,
      });

      expect(result.l0Count).toBe(7);
      expect(result.updated).toBe(true);

      const after = await manager.read();
      expect(after.l0_conversations_count).toBe(7);
    });

    it("should fix total_memories_extracted drift", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      // Initialize checkpoint
      await manager.captureAtomically("session-1", undefined, async () => ({
        maxTimestamp: 1000,
        messageCount: 5,
      }));

      // Mark L1 extraction (simulated)
      await manager.recalibrate({
        countL0: async () => 1,
        countL1: async () => 10,
      });

      // Simulate drift: checkpoint says 10, but storage has 3 (after cleanup)
      const result = await manager.recalibrate({
        countL0: async () => 1,
        countL1: async () => 3,
      });

      expect(result.l1Count).toBe(3);
      expect(result.updated).toBe(true);

      const after = await manager.read();
      expect(after.total_memories_extracted).toBe(3);
    });

    it("should fix both counters when both are drifted", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      // Initialize with known state
      await manager.captureAtomically("session-1", undefined, async () => ({
        maxTimestamp: 1000,
        messageCount: 5,
      }));

      // Simulate both counters drifted
      const result = await manager.recalibrate({
        countL0: async () => 5,
        countL1: async () => 20,
      });

      expect(result.l0Count).toBe(5);
      expect(result.l1Count).toBe(20);
      expect(result.updated).toBe(true);

      const after = await manager.read();
      expect(after.l0_conversations_count).toBe(5);
      expect(after.total_memories_extracted).toBe(20);
    });
  });

  describe("error handling", () => {
    it("should handle countL0 failure gracefully", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      // Initialize
      await manager.captureAtomically("session-1", undefined, async () => ({
        maxTimestamp: 1000,
        messageCount: 5,
      }));

      const before = await manager.read();

      // countL0 throws
      const result = await manager.recalibrate({
        countL0: async () => { throw new Error("Storage unavailable"); },
        countL1: async () => 0,
      });

      expect(result.error).toBe("Storage unavailable");
      expect(result.updated).toBe(false);

      // Checkpoint should be unchanged
      const after = await manager.read();
      expect(after.l0_conversations_count).toBe(before.l0_conversations_count);
    });

    it("should handle countL1 failure gracefully", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      const result = await manager.recalibrate({
        countL0: async () => 5,
        countL1: async () => { throw new Error("Database corrupted"); },
      });

      expect(result.error).toBe("Database corrupted");
      expect(result.updated).toBe(false);
    });

    it("should handle both count failures gracefully", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      const result = await manager.recalibrate({
        countL0: async () => { throw new Error("Error 1"); },
        countL1: async () => { throw new Error("Error 2"); },
      });

      expect(result.error).toBeDefined();
      expect(result.updated).toBe(false);
    });
  });

  describe("concurrency safety", () => {
    it("should handle concurrent recalibrate calls safely", async () => {
      const dataDir = createTempDir();
      const manager = new CheckpointManager(dataDir);

      // Initialize
      await manager.captureAtomically("session-1", undefined, async () => ({
        maxTimestamp: 1000,
        messageCount: 5,
      }));

      // Run multiple recalibrate in parallel - all should complete without error
      const results = await Promise.all([
        manager.recalibrate({ countL0: async () => 3, countL1: async () => 7 }),
        manager.recalibrate({ countL0: async () => 3, countL1: async () => 7 }),
        manager.recalibrate({ countL0: async () => 3, countL1: async () => 7 }),
      ]);

      // All should succeed without errors
      results.forEach((result) => {
        expect(result.error).toBeUndefined();
      });

      // At least one should have updated, others may be no-ops (already in sync)
      const updatedCount = results.filter((r) => r.updated).length;
      expect(updatedCount).toBeGreaterThanOrEqual(1);

      // Final state should be consistent with the expected values
      const after = await manager.read();
      expect(after.l0_conversations_count).toBe(3);
      expect(after.total_memories_extracted).toBe(7);
    });
  });

  describe("logging", () => {
    it("should call logger with info when counters are updated", async () => {
      const dataDir = createTempDir();
      const logger = { info: vi.fn(), warn: vi.fn() };
      const manager = new CheckpointManager(dataDir, logger);

      // Initialize
      await manager.captureAtomically("session-1", undefined, async () => ({
        maxTimestamp: 1000,
        messageCount: 5,
      }));

      await manager.recalibrate({
        countL0: async () => 3,
        countL1: async () => 7,
      });

      expect(logger.info).toHaveBeenCalled();
      const logMsg = logger.info.mock.calls[0][0];
      expect(logMsg).toContain("recalibrated");
      expect(logMsg).toContain("l0=3");
      expect(logMsg).toContain("l1=7");
    });

    it("should call logger with warn when recounting fails", async () => {
      const dataDir = createTempDir();
      const logger = { info: vi.fn(), warn: vi.fn() };
      const manager = new CheckpointManager(dataDir, logger);

      await manager.recalibrate({
        countL0: async () => { throw new Error("Count failed"); },
        countL1: async () => 0,
      });

      expect(logger.warn).toHaveBeenCalled();
      expect(logger.warn.mock.calls[0][0]).toContain("Count failed");
    });
  });
});
