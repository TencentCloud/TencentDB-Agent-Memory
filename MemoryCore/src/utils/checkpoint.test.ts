import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CheckpointManager } from "./checkpoint.js";
import { StorageAdapter } from "../core/storage/adapter.js";
import { LocalStorageBackend } from "../core/storage/local-backend.js";

describe("CheckpointManager.recalibrateCounters", () => {
  const tempDirs: string[] = [];

  async function createManager(): Promise<{
    dataDir: string;
    manager: CheckpointManager;
  }> {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "checkpoint-test-"),
    );

    tempDirs.push(dataDir);

    return {
      dataDir,
      manager: new CheckpointManager(dataDir),
    };
  }

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) =>
        fs.rm(dir, { recursive: true, force: true }),
      ),
    );
  });

  it("recalibrates counters downward without changing other fields", async () => {
    const { manager } = await createManager();

    const checkpoint = await manager.read();

    await manager.write({
      ...checkpoint,
      total_processed: 100,
      memories_since_last_persona: 7,
      l0_conversations_count: 50,
      total_memories_extracted: 42,
      runner_states: {
        "session-1": {
          last_captured_timestamp: 123,
          last_l1_cursor: 456,
          last_scene_name: "test scene",
        },
      },
    });

    await manager.recalibrateCounters(40, 34);

    const result = await manager.read();

    expect(result.l0_conversations_count).toBe(40);
    expect(result.total_memories_extracted).toBe(34);

    expect(result.total_processed).toBe(100);
    expect(result.memories_since_last_persona).toBe(7);
    expect(result.runner_states["session-1"]).toEqual({
      last_captured_timestamp: 123,
      last_l1_cursor: 456,
      last_scene_name: "test scene",
    });
  });

  it("recalibrates counters upward", async () => {
    const { manager } = await createManager();

    await manager.recalibrateCounters(10, 8);
    await manager.recalibrateCounters(15, 12);

    const result = await manager.read();

    expect(result.l0_conversations_count).toBe(15);
    expect(result.total_memories_extracted).toBe(12);
  });

  it("allows counters to be recalibrated to zero", async () => {
    const { manager } = await createManager();

    await manager.recalibrateCounters(10, 8);
    await manager.recalibrateCounters(0, 0);

    const result = await manager.read();

    expect(result.l0_conversations_count).toBe(0);
    expect(result.total_memories_extracted).toBe(0);
  });

  it("rejects invalid counter values", async () => {
    const { manager } = await createManager();

    await expect(
      manager.recalibrateCounters(-1, 10),
    ).rejects.toThrow("Invalid checkpoint counters");

    await expect(
      manager.recalibrateCounters(10, Number.NaN),
    ).rejects.toThrow("Invalid checkpoint counters");
  });

  it("recalibrates the checkpoint selected by a storage adapter", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "checkpoint-storage-test-"),
    );
    tempDirs.push(dataDir);

    const storage = new StorageAdapter(new LocalStorageBackend(dataDir));
    const manager = new CheckpointManager(
      path.join(dataDir, "unused-local-path"),
      undefined,
      storage,
    );

    await manager.recalibrateCounters(6, 4);

    const result = await manager.read();
    expect(result.l0_conversations_count).toBe(6);
    expect(result.total_memories_extracted).toBe(4);
    await expect(
      fs.readFile(path.join(dataDir, ".metadata", "checkpoint.json"), "utf-8"),
    ).resolves.toContain('"total_memories_extracted": 4');
  });
});
