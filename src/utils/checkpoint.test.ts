import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CheckpointManager,
  reconcileCheckpointFromStore,
} from "./checkpoint.js";
import { LocalMemoryCleaner } from "./memory-cleaner.js";
import type { IMemoryStore } from "../core/store/types.js";

const tempDirs: string[] = [];

async function createCheckpointManager(): Promise<CheckpointManager> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-checkpoint-"));
  tempDirs.push(dataDir);
  return new CheckpointManager(dataDir);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Checkpoint counter reconciliation", () => {
  it("counts every message in a captured L0 batch", async () => {
    const manager = await createCheckpointManager();

    await manager.captureAtomically("session-a", undefined, async () => ({
      maxTimestamp: 1000,
      messageCount: 2,
    }));

    expect(await manager.read()).toMatchObject({
      total_processed: 2,
      l0_conversations_count: 2,
    });
  });

  it("rebuilds current counters without decreasing the historical total", async () => {
    const manager = await createCheckpointManager();
    const initial = await manager.read();
    await manager.write({
      ...initial,
      total_processed: 100,
      l0_conversations_count: 40,
      total_memories_extracted: 80,
      memories_since_last_persona: 30,
      last_persona_time: "2026-07-20T00:00:00.000Z",
    });
    const store = {
      countL0: () => 6,
      countL1: () => 4,
      queryL1Records: () => [
        { updated_time: "2026-07-21T00:00:00.000Z" },
        { updated_time: "2026-07-22T00:00:00.000Z" },
      ],
    };

    await reconcileCheckpointFromStore(manager, store);

    expect(await manager.read()).toMatchObject({
      total_processed: 100,
      l0_conversations_count: 6,
      total_memories_extracted: 4,
      memories_since_last_persona: 2,
    });
  });

  it("does not overwrite checkpoint counters when Store counting fails", async () => {
    const manager = await createCheckpointManager();
    const initial = await manager.read();
    await manager.write({ ...initial, l0_conversations_count: 9 });
    const before = await manager.read();
    const store = {
      countL0: () => { throw new Error("database unavailable"); },
      countL1: () => 2,
      queryL1Records: () => [],
    };

    await expect(reconcileCheckpointFromStore(manager, store)).rejects.toThrow("database unavailable");
    expect(await manager.read()).toEqual(before);
  });

  it("reconciles counters after Cleaner deletes Store records", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-checkpoint-"));
    tempDirs.push(dataDir);
    const manager = new CheckpointManager(dataDir);
    const initial = await manager.read();
    await manager.write({
      ...initial,
      total_processed: 100,
      l0_conversations_count: 100,
      total_memories_extracted: 40,
      memories_since_last_persona: 20,
      last_persona_time: "2026-07-20T00:00:00.000Z",
    });

    let l0Count = 52;
    let l1Count = 22;
    const store = {
      isDegraded: () => false,
      countL0: () => l0Count,
      countL1: () => l1Count,
      deleteL0Expired: () => { l0Count -= 2; return 2; },
      deleteL1Expired: () => { l1Count -= 2; return 2; },
      queryL1Records: () => [{ updated_time: "2026-07-21T00:00:00.000Z" }],
    } as unknown as IMemoryStore;
    const cleaner = new LocalMemoryCleaner({
      baseDir: dataDir,
      retentionDays: 2,
      cleanTime: "03:00",
      vectorStore: store,
    });

    await cleaner.runOnce(new Date("2026-07-24T12:00:00.000Z").getTime());

    expect(await manager.read()).toMatchObject({
      total_processed: 100,
      l0_conversations_count: 50,
      total_memories_extracted: 20,
      memories_since_last_persona: 1,
    });
  });

  it("does not change counters when Cleaner deletes no records", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-checkpoint-"));
    tempDirs.push(dataDir);
    const manager = new CheckpointManager(dataDir);
    const initial = await manager.read();
    await manager.write({ ...initial, l0_conversations_count: 50, total_memories_extracted: 20 });
    const before = await manager.read();
    const store = {
      isDegraded: () => false,
      countL0: () => 50,
      countL1: () => 20,
      deleteL0Expired: () => 0,
      deleteL1Expired: () => 0,
      queryL1Records: () => [],
    } as unknown as IMemoryStore;
    const cleaner = new LocalMemoryCleaner({
      baseDir: dataDir,
      retentionDays: 2,
      cleanTime: "03:00",
      vectorStore: store,
    });

    await cleaner.runOnce(new Date("2026-07-24T12:00:00.000Z").getTime());

    expect(await manager.read()).toEqual(before);
  });
});
