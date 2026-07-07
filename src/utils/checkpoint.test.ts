import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

import { CheckpointManager } from "./checkpoint.js";

describe("CheckpointManager counter adjustment", () => {
  let tempDir: string;
  let checkpointManager: CheckpointManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(process.cwd(), "checkpoint-test-"));
    checkpointManager = new CheckpointManager(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("adjustGlobalCounters decrements counters correctly", async () => {
    await checkpointManager.recalibrate({
      l0_conversations_count: 100,
      total_memories_extracted: 50,
      total_processed: 200,
      scenes_processed: 10,
    });

    await checkpointManager.adjustGlobalCounters({
      l0_conversations_count: -20,
      total_memories_extracted: -10,
      total_processed: -30,
      scenes_processed: -2,
    });

    const cp = await checkpointManager.read();
    expect(cp.l0_conversations_count).toBe(80);
    expect(cp.total_memories_extracted).toBe(40);
    expect(cp.total_processed).toBe(170);
    expect(cp.scenes_processed).toBe(8);
  });

  it("adjustGlobalCounters increments counters correctly", async () => {
    await checkpointManager.recalibrate({
      l0_conversations_count: 10,
      total_memories_extracted: 5,
    });

    await checkpointManager.adjustGlobalCounters({
      l0_conversations_count: 5,
      total_memories_extracted: 3,
    });

    const cp = await checkpointManager.read();
    expect(cp.l0_conversations_count).toBe(15);
    expect(cp.total_memories_extracted).toBe(8);
  });

  it("adjustGlobalCounters protects counters from going below zero", async () => {
    await checkpointManager.recalibrate({
      l0_conversations_count: 5,
      total_memories_extracted: 3,
    });

    await checkpointManager.adjustGlobalCounters({
      l0_conversations_count: -10,
      total_memories_extracted: -5,
    });

    const cp = await checkpointManager.read();
    expect(cp.l0_conversations_count).toBe(0);
    expect(cp.total_memories_extracted).toBe(0);
  });

  it("adjustGlobalCounters handles partial delta updates", async () => {
    await checkpointManager.recalibrate({
      l0_conversations_count: 100,
      total_memories_extracted: 50,
    });

    await checkpointManager.adjustGlobalCounters({
      l0_conversations_count: -10,
    });

    const cp = await checkpointManager.read();
    expect(cp.l0_conversations_count).toBe(90);
    expect(cp.total_memories_extracted).toBe(50);
  });

  it("recalibrate replaces counters with actual values", async () => {
    await checkpointManager.recalibrate({
      l0_conversations_count: 1000,
      total_memories_extracted: 500,
      total_processed: 2000,
      scenes_processed: 100,
    });

    await checkpointManager.adjustGlobalCounters({
      memories_since_last_persona: 50,
    });

    await checkpointManager.recalibrate({
      l0_conversations_count: 50,
      total_memories_extracted: 25,
      total_processed: 100,
      scenes_processed: 5,
    });

    const cp = await checkpointManager.read();
    expect(cp.l0_conversations_count).toBe(50);
    expect(cp.total_memories_extracted).toBe(25);
    expect(cp.total_processed).toBe(100);
    expect(cp.scenes_processed).toBe(5);
    expect(cp.memories_since_last_persona).toBe(0);
  });

  it("recalibrate handles partial actual count updates", async () => {
    await checkpointManager.recalibrate({
      l0_conversations_count: 1000,
      total_memories_extracted: 500,
    });

    await checkpointManager.recalibrate({
      l0_conversations_count: 50,
    });

    const cp = await checkpointManager.read();
    expect(cp.l0_conversations_count).toBe(50);
    expect(cp.total_memories_extracted).toBe(500);
  });

  it("recalibrate protects counters from going below zero", async () => {
    await checkpointManager.recalibrate({
      l0_conversations_count: 100,
    });

    await checkpointManager.recalibrate({
      l0_conversations_count: -50,
    });

    const cp = await checkpointManager.read();
    expect(cp.l0_conversations_count).toBe(0);
  });

  it("adjustGlobalCounters logs the adjustment", async () => {
    const logger = {
      info: vi.fn(),
    };
    const manager = new CheckpointManager(tempDir, logger);

    await manager.recalibrate({
      l0_conversations_count: 100,
      total_memories_extracted: 50,
    });

    await manager.adjustGlobalCounters({
      l0_conversations_count: -20,
      total_memories_extracted: -10,
    });

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("adjustGlobalCounters"));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("l0_conversations_count=80"));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("total_memories_extracted=40"));
  });

  it("recalibrate logs the recalibration", async () => {
    const logger = {
      info: vi.fn(),
    };
    const manager = new CheckpointManager(tempDir, logger);

    await manager.recalibrate({
      l0_conversations_count: 100,
    });

    await manager.recalibrate({
      l0_conversations_count: 50,
    });

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("recalibrate"));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("l0_conversations_count=50"));
  });
});