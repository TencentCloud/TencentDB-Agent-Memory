import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointManager } from "./checkpoint.js";

describe("CheckpointManager.recalculate()", () => {
  let tmpDir: string;
  let cpManager: CheckpointManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "checkpoint-test-"));
    cpManager = new CheckpointManager(tmpDir);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should overwrite l0 and l1 counters", async () => {
    await cpManager.recalculate({
      l0Conversations: 42,
      l1Memories: 100,
    });
    const cp = await cpManager.read();
    expect(cp.l0_conversations_count).toBe(42);
    expect(cp.total_memories_extracted).toBe(100);
  });

  it("should not touch fields that are not provided", async () => {
    // Write a known initial state
    await cpManager.recalculate({
      l0Conversations: 10,
      l1Memories: 20,
      scenesProcessed: 5,
    });

    // Partial recalculate — only update L0
    await cpManager.recalculate({ l0Conversations: 99 });

    const cp = await cpManager.read();
    expect(cp.l0_conversations_count).toBe(99); // updated
    expect(cp.total_memories_extracted).toBe(20); // unchanged
    expect(cp.scenes_processed).toBe(5); // unchanged
  });

  it("should handle zero counts", async () => {
    // Start with non-zero values
    await cpManager.recalculate({
      l0Conversations: 50,
      l1Memories: 200,
    });

    // Reset to zero (simulating empty store after cleanup)
    await cpManager.recalculate({
      l0Conversations: 0,
      l1Memories: 0,
    });

    const cp = await cpManager.read();
    expect(cp.l0_conversations_count).toBe(0);
    expect(cp.total_memories_extracted).toBe(0);
  });

  it("should return the full checkpoint after mutation", async () => {
    const cp = await cpManager.recalculate({
      l0Conversations: 7,
      l1Memories: 13,
    });
    expect(cp.l0_conversations_count).toBe(7);
    expect(cp.total_memories_extracted).toBe(13);
    // Should contain other default fields
    expect(typeof cp.total_processed).toBe("number");
    expect(typeof cp.scenes_processed).toBe("number");
  });
});

describe("CheckpointManager.recalculate() — drift scenarios", () => {
  let tmpDir: string;
  let cpManager: CheckpointManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "checkpoint-drift-"));
    cpManager = new CheckpointManager(tmpDir);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should correct inflated counter after simulated cleanup", async () => {
    // Simulate: checkpoint was inflated to 100 but actual store only has 80
    await cpManager.recalculate({
      l0Conversations: 100,
      l1Memories: 500,
    });

    // Cleanup happened — actual data is now 80 and 420
    await cpManager.recalculate({
      l0Conversations: 80,
      l1Memories: 420,
    });

    const cp = await cpManager.read();
    expect(cp.l0_conversations_count).toBe(80);
    expect(cp.total_memories_extracted).toBe(420);
  });

  it("should handle only l0Conversations while l1Memories undefined", async () => {
    await cpManager.recalculate({ l0Conversations: 10, l1Memories: 30 });
    await cpManager.recalculate({ l0Conversations: 5 }); // only L0

    const cp = await cpManager.read();
    expect(cp.l0_conversations_count).toBe(5);
    expect(cp.total_memories_extracted).toBe(30); // unchanged
  });

  it("should handle only l1Memories while l0Conversations undefined", async () => {
    await cpManager.recalculate({ l0Conversations: 10, l1Memories: 30 });
    await cpManager.recalculate({ l1Memories: 15 }); // only L1

    const cp = await cpManager.read();
    expect(cp.l0_conversations_count).toBe(10); // unchanged
    expect(cp.total_memories_extracted).toBe(15);
  });

  it("should handle mixed update: some provided, some not", async () => {
    await cpManager.recalculate({
      l0Conversations: 10,
      l1Memories: 10,
      totalProcessed: 10,
      scenesProcessed: 10,
    });

    // Only update two fields, leave others
    await cpManager.recalculate({
      l0Conversations: 5,
      scenesProcessed: 5,
    });

    const cp = await cpManager.read();
    expect(cp.l0_conversations_count).toBe(5);
    expect(cp.total_memories_extracted).toBe(10); // unchanged
    expect(cp.total_processed).toBe(10); // unchanged
    expect(cp.scenes_processed).toBe(5);
  });
});

describe("CheckpointManager.recalculate() — edge cases", () => {
  let tmpDir: string;
  let cpManager: CheckpointManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "checkpoint-edge-"));
    cpManager = new CheckpointManager(tmpDir);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should not overwrite counter when value is explicitly undefined", async () => {
    // Establish baseline
    await cpManager.recalculate({ l0Conversations: 10, l1Memories: 20 });
    const before = await cpManager.read();

    // Simulate store unavailable: caller passes undefined
    await cpManager.recalculate({ l0Conversations: undefined, l1Memories: undefined });
    const after = await cpManager.read();

    expect(after.l0_conversations_count).toBe(before.l0_conversations_count);
    expect(after.total_memories_extracted).toBe(before.total_memories_extracted);
  });

  it("should not change any counter with an empty object", async () => {
    await cpManager.recalculate({
      l0Conversations: 10,
      l1Memories: 20,
      totalProcessed: 100,
      scenesProcessed: 3,
    });

    await cpManager.recalculate({});

    const cp = await cpManager.read();
    expect(cp.l0_conversations_count).toBe(10);
    expect(cp.total_memories_extracted).toBe(20);
    expect(cp.total_processed).toBe(100);
    expect(cp.scenes_processed).toBe(3);
  });

  it("should update all four counters simultaneously", async () => {
    await cpManager.recalculate({
      l0Conversations: 1,
      l1Memories: 2,
      totalProcessed: 3,
      scenesProcessed: 4,
    });

    const cp = await cpManager.read();
    expect(cp.l0_conversations_count).toBe(1);
    expect(cp.total_memories_extracted).toBe(2);
    expect(cp.total_processed).toBe(3);
    expect(cp.scenes_processed).toBe(4);
  });
});
