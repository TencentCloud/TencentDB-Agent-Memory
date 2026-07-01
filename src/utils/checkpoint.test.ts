import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CheckpointManager, type Checkpoint } from "./checkpoint.js";

describe("CheckpointManager.recalibrate", () => {
  let tmpDir: string;
  let manager: CheckpointManager;
  const logMessages: string[] = [];
  const testLogger = {
    info(msg: string) {
      logMessages.push(msg);
    },
    warn(msg: string) {
      logMessages.push(`[warn] ${msg}`);
    },
  };

  beforeEach(async () => {
    logMessages.length = 0;
    tmpDir = path.join(
      os.tmpdir(),
      `checkpoint-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    manager = new CheckpointManager(tmpDir, testLogger);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Write an initial checkpoint with known counter values */
  async function seedCheckpoint(checkpoint: Checkpoint): Promise<void> {
    await manager.write(checkpoint);
  }

  /** Read the checkpoint file directly from disk to verify on-disk state */
  async function readCheckpointOnDisk(): Promise<Checkpoint> {
    const raw = await fs.readFile(
      path.join(tmpDir, ".metadata", "recall_checkpoint.json"),
      "utf-8",
    );
    return JSON.parse(raw) as Checkpoint;
  }

  it("updates l0_conversations_count when it differs from actual", async () => {
    await seedCheckpoint({
      ...(await manager.read()),
      l0_conversations_count: 100,
      total_memories_extracted: 50,
    });

    const result = await manager.recalibrate(80, 50);

    expect(result.l0Changed).toBe(true);
    expect(result.l1Changed).toBe(false);

    const onDisk = await readCheckpointOnDisk();
    expect(onDisk.l0_conversations_count).toBe(80);
    expect(onDisk.total_memories_extracted).toBe(50);

    // Verify log was emitted for the changed counter
    const l0Log = logMessages.find(
      (m) => m.includes("l0_conversations_count") && m.includes("100 → 80"),
    );
    expect(l0Log).toBeTruthy();
  });

  it("updates total_memories_extracted when it differs from actual", async () => {
    await seedCheckpoint({
      ...(await manager.read()),
      l0_conversations_count: 100,
      total_memories_extracted: 200,
    });

    const result = await manager.recalibrate(100, 150);

    expect(result.l0Changed).toBe(false);
    expect(result.l1Changed).toBe(true);

    const onDisk = await readCheckpointOnDisk();
    expect(onDisk.l0_conversations_count).toBe(100);
    expect(onDisk.total_memories_extracted).toBe(150);

    const l1Log = logMessages.find(
      (m) => m.includes("total_memories_extracted") && m.includes("200 → 150"),
    );
    expect(l1Log).toBeTruthy();
  });

  it("updates both counters when both differ", async () => {
    await seedCheckpoint({
      ...(await manager.read()),
      l0_conversations_count: 500,
      total_memories_extracted: 1000,
    });

    const result = await manager.recalibrate(300, 700);

    expect(result.l0Changed).toBe(true);
    expect(result.l1Changed).toBe(true);

    const onDisk = await readCheckpointOnDisk();
    expect(onDisk.l0_conversations_count).toBe(300);
    expect(onDisk.total_memories_extracted).toBe(700);
  });

  it("does nothing and logs nothing when counts already match", async () => {
    await seedCheckpoint({
      ...(await manager.read()),
      l0_conversations_count: 42,
      total_memories_extracted: 17,
    });

    const logBefore = logMessages.length;
    const result = await manager.recalibrate(42, 17);

    expect(result.l0Changed).toBe(false);
    expect(result.l1Changed).toBe(false);
    expect(logMessages.length).toBe(logBefore); // no new log messages

    const onDisk = await readCheckpointOnDisk();
    expect(onDisk.l0_conversations_count).toBe(42);
    expect(onDisk.total_memories_extracted).toBe(17);
  });

  it("handles zero actual counts (clean store)", async () => {
    await seedCheckpoint({
      ...(await manager.read()),
      l0_conversations_count: 10,
      total_memories_extracted: 5,
    });

    const result = await manager.recalibrate(0, 0);

    expect(result.l0Changed).toBe(true);
    expect(result.l1Changed).toBe(true);

    const onDisk = await readCheckpointOnDisk();
    expect(onDisk.l0_conversations_count).toBe(0);
    expect(onDisk.total_memories_extracted).toBe(0);
  });

  it("works when checkpoint file does not exist yet (uses defaults)", async () => {
    // No seed — the file does not exist
    const result = await manager.recalibrate(25, 10);

    // Defaults are 0, so both should change
    expect(result.l0Changed).toBe(true);
    expect(result.l1Changed).toBe(true);

    const onDisk = await readCheckpointOnDisk();
    expect(onDisk.l0_conversations_count).toBe(25);
    expect(onDisk.total_memories_extracted).toBe(10);
  });

  it("does not mutate other checkpoint fields", async () => {
    const original = {
      ...(await manager.read()),
      l0_conversations_count: 999,
      total_memories_extracted: 888,
      total_processed: 12345,
      scenes_processed: 67,
      last_captured_timestamp: 1719000000000,
    };
    await seedCheckpoint(original);

    await manager.recalibrate(500, 400);

    const onDisk = await readCheckpointOnDisk();
    expect(onDisk.total_processed).toBe(12345);
    expect(onDisk.scenes_processed).toBe(67);
    expect(onDisk.last_captured_timestamp).toBe(1719000000000);
  });
});
