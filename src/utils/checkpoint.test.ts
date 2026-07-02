import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  CheckpointManager,
  countJsonlL0Records,
  countJsonlL1Records,
  type Checkpoint,
} from "./checkpoint.js";

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

  // ═══ Basic counter recalibration ═══

  it("updates l0_conversations_count when it differs from actual", async () => {
    await seedCheckpoint({
      ...(await manager.read()),
      l0_conversations_count: 100,
      total_memories_extracted: 50,
    });

    const result = await manager.recalibrate({ l0Count: 80, l1Count: 50 });

    expect(result.l0Changed).toBe(true);
    expect(result.l1Changed).toBe(false);

    const onDisk = await readCheckpointOnDisk();
    expect(onDisk.l0_conversations_count).toBe(80);
    expect(onDisk.total_memories_extracted).toBe(50);

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

    const result = await manager.recalibrate({ l0Count: 100, l1Count: 150 });

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

    const result = await manager.recalibrate({ l0Count: 300, l1Count: 700 });

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
    const result = await manager.recalibrate({ l0Count: 42, l1Count: 17 });

    expect(result.l0Changed).toBe(false);
    expect(result.l1Changed).toBe(false);
    expect(logMessages.length).toBe(logBefore);

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

    const result = await manager.recalibrate({ l0Count: 0, l1Count: 0 });

    expect(result.l0Changed).toBe(true);
    expect(result.l1Changed).toBe(true);

    const onDisk = await readCheckpointOnDisk();
    expect(onDisk.l0_conversations_count).toBe(0);
    expect(onDisk.total_memories_extracted).toBe(0);
  });

  it("works when checkpoint file does not exist yet (uses defaults)", async () => {
    const result = await manager.recalibrate({ l0Count: 25, l1Count: 10 });

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

    await manager.recalibrate({ l0Count: 500, l1Count: 400 });

    const onDisk = await readCheckpointOnDisk();
    expect(onDisk.total_processed).toBe(12345);
    expect(onDisk.scenes_processed).toBe(67);
    expect(onDisk.last_captured_timestamp).toBe(1719000000000);
  });

  // ═══ Options-based API ═══

  it("only updates L0 when only l0Count is provided", async () => {
    await seedCheckpoint({
      ...(await manager.read()),
      l0_conversations_count: 100,
      total_memories_extracted: 50,
    });

    const result = await manager.recalibrate({ l0Count: 80 });

    expect(result.l0Changed).toBe(true);
    expect(result.l1Changed).toBe(false);

    const onDisk = await readCheckpointOnDisk();
    expect(onDisk.l0_conversations_count).toBe(80);
    expect(onDisk.total_memories_extracted).toBe(50); // unchanged
  });

  it("only updates L1 when only l1Count is provided", async () => {
    await seedCheckpoint({
      ...(await manager.read()),
      l0_conversations_count: 100,
      total_memories_extracted: 50,
    });

    const result = await manager.recalibrate({ l1Count: 30 });

    expect(result.l0Changed).toBe(false);
    expect(result.l1Changed).toBe(true);
  });

  it("returns no changes when called with empty options", async () => {
    await seedCheckpoint({
      ...(await manager.read()),
      l0_conversations_count: 5,
      total_memories_extracted: 3,
    });

    const result = await manager.recalibrate({});
    expect(result.l0Changed).toBe(false);
    expect(result.l1Changed).toBe(false);
    expect(result.cursorsRolledBack).toBe(0);
  });

  it("returns no changes when called with no arguments", async () => {
    await seedCheckpoint({
      ...(await manager.read()),
      l0_conversations_count: 5,
      total_memories_extracted: 3,
    });

    const result = await manager.recalibrate();
    expect(result.l0Changed).toBe(false);
    expect(result.l1Changed).toBe(false);
    expect(result.cursorsRolledBack).toBe(0);
  });

  it("handles negative counts (clamped by caller, accepted as-is)", async () => {
    await seedCheckpoint({
      ...(await manager.read()),
      l0_conversations_count: 0,
      total_memories_extracted: 0,
    });

    // recalibrate writes whatever the caller passes; clamping is the caller's job
    const result = await manager.recalibrate({ l0Count: -1, l1Count: -5 });
    expect(result.l0Changed).toBe(true);
    expect(result.l1Changed).toBe(true);

    const onDisk = await readCheckpointOnDisk();
    expect(onDisk.l0_conversations_count).toBe(-1);
    expect(onDisk.total_memories_extracted).toBe(-5);
  });

  it("is idempotent: second call with same values is a no-op", async () => {
    await seedCheckpoint({
      ...(await manager.read()),
      l0_conversations_count: 0,
      total_memories_extracted: 0,
    });

    await manager.recalibrate({ l0Count: 10, l1Count: 5 });
    const logBefore = logMessages.length;
    const result = await manager.recalibrate({ l0Count: 10, l1Count: 5 });

    expect(result.l0Changed).toBe(false);
    expect(result.l1Changed).toBe(false);
    expect(logMessages.length).toBe(logBefore);
  });

  // ═══ Cursor rollback ═══

  it("rolls back stale last_l1_cursor when below earliestValidL0Timestamp", async () => {
    const cp = await manager.read();
    cp.runner_states = {
      "sess-a": {
        last_captured_timestamp: 5000,
        last_l1_cursor: 1000, // stale — before cleanup
        last_scene_name: "scene1",
      },
      "sess-b": {
        last_captured_timestamp: 8000,
        last_l1_cursor: 7000, // still valid
        last_scene_name: "scene2",
      },
    };
    await seedCheckpoint(cp);

    const result = await manager.recalibrate({ earliestValidL0Timestamp: 3000 });

    expect(result.cursorsRolledBack).toBe(1); // only sess-a's cursor was stale

    const onDisk = await readCheckpointOnDisk();
    expect(onDisk.runner_states["sess-a"].last_l1_cursor).toBe(3000);
    expect(onDisk.runner_states["sess-b"].last_l1_cursor).toBe(7000); // unchanged
  });

  it("does not roll back cursor when earliestValidL0Timestamp is not provided", async () => {
    const cp = await manager.read();
    cp.runner_states = {
      "sess-a": {
        last_captured_timestamp: 5000,
        last_l1_cursor: 1000,
        last_scene_name: "scene1",
      },
    };
    await seedCheckpoint(cp);

    const result = await manager.recalibrate({ l0Count: 5 });
    expect(result.cursorsRolledBack).toBe(0);

    const onDisk = await readCheckpointOnDisk();
    expect(onDisk.runner_states["sess-a"].last_l1_cursor).toBe(1000);
  });

  it("does not roll back cursor that is already 0 (never processed)", async () => {
    const cp = await manager.read();
    cp.runner_states = {
      "sess-a": {
        last_captured_timestamp: 0,
        last_l1_cursor: 0,
        last_scene_name: "",
      },
    };
    await seedCheckpoint(cp);

    const result = await manager.recalibrate({ earliestValidL0Timestamp: 1000 });
    expect(result.cursorsRolledBack).toBe(0); // 0 means never-processed, don't touch
  });

  it("cursor rollback + counter update in single mutate", async () => {
    const cp = await manager.read();
    cp.l0_conversations_count = 100;
    cp.total_memories_extracted = 100;
    cp.runner_states = {
      "sess-a": {
        last_captured_timestamp: 1000,
        last_l1_cursor: 500, // stale
        last_scene_name: "",
      },
    };
    await seedCheckpoint(cp);

    const result = await manager.recalibrate({
      l0Count: 50,
      l1Count: 30,
      earliestValidL0Timestamp: 1000,
    });

    expect(result.l0Changed).toBe(true);
    expect(result.l1Changed).toBe(true);
    expect(result.cursorsRolledBack).toBe(1);

    const onDisk = await readCheckpointOnDisk();
    expect(onDisk.l0_conversations_count).toBe(50);
    expect(onDisk.total_memories_extracted).toBe(30);
    expect(onDisk.runner_states["sess-a"].last_l1_cursor).toBe(1000);
  });

  it("cursor rollback preserves pipeline_states untouched", async () => {
    const cp = await manager.read();
    cp.runner_states = {
      "sess-a": {
        last_captured_timestamp: 2000,
        last_l1_cursor: 500,
        last_scene_name: "",
      },
    };
    cp.pipeline_states = {
      "sess-a": {
        conversation_count: 42,
        last_extraction_time: "2026-01-01T00:00:00Z",
        last_extraction_updated_time: "",
        last_active_time: 2000,
        l2_pending_l1_count: 3,
        warmup_threshold: 4,
        l2_last_extraction_time: "",
      },
    };
    await seedCheckpoint(cp);

    await manager.recalibrate({ earliestValidL0Timestamp: 1000 });

    const onDisk = await readCheckpointOnDisk();
    expect(onDisk.pipeline_states["sess-a"].conversation_count).toBe(42);
    expect(onDisk.pipeline_states["sess-a"].warmup_threshold).toBe(4);
  });

  it("cursor rollback on empty runner_states returns 0", async () => {
    const cp = await manager.read();
    cp.runner_states = {};
    await seedCheckpoint(cp);

    const result = await manager.recalibrate({ earliestValidL0Timestamp: 1000 });
    expect(result.cursorsRolledBack).toBe(0);
  });

  it("cursor rollback on undefined runner_states returns 0", async () => {
    await seedCheckpoint({ ...(await manager.read()), runner_states: undefined as any });
    const result = await manager.recalibrate({ earliestValidL0Timestamp: 1000 });
    expect(result.cursorsRolledBack).toBe(0);
  });

  // ═══ JSONL recounting helpers ═══

  it("countJsonlL0Records returns 0 for empty directory", async () => {
    const count = await countJsonlL0Records(tmpDir, testLogger);
    expect(count).toBe(0);
  });

  it("countJsonlL1Records returns 0 for empty directory", async () => {
    const count = await countJsonlL1Records(tmpDir, testLogger);
    expect(count).toBe(0);
  });

  it("countJsonlL0Records counts lines in JSONL files", async () => {
    const convDir = path.join(tmpDir, "conversations");
    await fs.mkdir(convDir, { recursive: true });
    await fs.writeFile(
      path.join(convDir, "2026-01-01.jsonl"),
      '{"a":1}\n{"b":2}\n{"c":3}\n',
    );
    await fs.writeFile(
      path.join(convDir, "2026-01-02.jsonl"),
      '{"d":4}\n\n', // blank line should be ignored
    );

    const count = await countJsonlL0Records(tmpDir, testLogger);
    expect(count).toBe(4); // 3 + 1 (blank line filtered)
  });

  it("countJsonlL1Records counts lines in JSONL files", async () => {
    const recDir = path.join(tmpDir, "records");
    await fs.mkdir(recDir, { recursive: true });
    await fs.writeFile(
      path.join(recDir, "2026-01-01.jsonl"),
      '{"x":1}\n{"y":2}\n',
    );

    const count = await countJsonlL1Records(tmpDir, testLogger);
    expect(count).toBe(2);
  });

  it("countJsonlL0Records skips non-JSONL files", async () => {
    const convDir = path.join(tmpDir, "conversations");
    await fs.mkdir(convDir, { recursive: true });
    await fs.writeFile(path.join(convDir, "2026-01-01.jsonl"), '{"a":1}\n');
    await fs.writeFile(path.join(convDir, "README.txt"), "ignore me");

    const count = await countJsonlL0Records(tmpDir, testLogger);
    expect(count).toBe(1);
  });

  it("countJsonl returns 0 for non-existent directory", async () => {
    // tmpDir has no conversations/ or records/ subdirectories
    const l0 = await countJsonlL0Records(tmpDir, testLogger);
    const l1 = await countJsonlL1Records(tmpDir, testLogger);
    expect(l0).toBe(0);
    expect(l1).toBe(0);
  });
});
