import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { IMemoryStore } from "../core/store/types.js";
import { CheckpointManager } from "./checkpoint.js";
import { LocalMemoryCleaner } from "./memory-cleaner.js";

const tempDirs: string[] = [];

async function createDataDir(): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-test-"));
  tempDirs.push(dataDir);
  await Promise.all([
    fs.mkdir(path.join(dataDir, ".metadata"), { recursive: true }),
    fs.mkdir(path.join(dataDir, "conversations"), { recursive: true }),
    fs.mkdir(path.join(dataDir, "records"), { recursive: true }),
  ]);
  return dataDir;
}

async function writeCheckpoint(manager: CheckpointManager, values: Partial<Awaited<ReturnType<CheckpointManager["read"]>>>): Promise<void> {
  await manager.write({ ...await manager.read(), ...values });
}

function counterStore(l0: number, l1: number): IMemoryStore {
  return {
    isDegraded: () => false,
    countL0: () => l0,
    countL1: () => l1,
  } as IMemoryStore;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("CheckpointManager.recalibrate", () => {
  it("uses live store counts and preserves per-session cursor state", async () => {
    const dataDir = await createDataDir();
    const manager = new CheckpointManager(dataDir);
    await writeCheckpoint(manager, {
      l0_conversations_count: 50,
      total_memories_extracted: 50,
      memories_since_last_persona: 50,
      runner_states: { session: { last_captured_timestamp: 42, last_l1_cursor: 40, last_scene_name: "scene" } },
      pipeline_states: { session: { conversation_count: 2, last_extraction_time: "", last_extraction_updated_time: "", last_active_time: 1, l2_pending_l1_count: 0, warmup_threshold: 0, l2_last_extraction_time: "" } },
    });

    await manager.recalibrate(counterStore(9, 4));

    await expect(manager.read()).resolves.toMatchObject({
      l0_conversations_count: 9,
      total_memories_extracted: 4,
      memories_since_last_persona: 4,
      runner_states: { session: { last_captured_timestamp: 42, last_l1_cursor: 40, last_scene_name: "scene" } },
      pipeline_states: { session: { conversation_count: 2 } },
    });
  });

  it("falls back to non-empty JSONL records when a store is unavailable", async () => {
    const dataDir = await createDataDir();
    await fs.writeFile(path.join(dataDir, "conversations", "2026-07-27.jsonl"), "one\n\ntwo\n");
    await fs.writeFile(path.join(dataDir, "records", "2026-07-27.jsonl"), "one\ntwo\nthree\n");
    const manager = new CheckpointManager(dataDir);
    await writeCheckpoint(manager, { l0_conversations_count: 50, total_memories_extracted: 50 });

    await manager.recalibrate();

    await expect(manager.read()).resolves.toMatchObject({
      l0_conversations_count: 2,
      total_memories_extracted: 3,
    });
  });

  it("keeps cleaner-run checkpoints aligned even when no records are eligible for deletion", async () => {
    const dataDir = await createDataDir();
    const manager = new CheckpointManager(dataDir);
    await writeCheckpoint(manager, { l0_conversations_count: 50, total_memories_extracted: 50 });
    const cleaner = new LocalMemoryCleaner({
      baseDir: dataDir,
      retentionDays: 2,
      cleanTime: "03:00",
      vectorStore: counterStore(3, 2),
    });

    await cleaner.runOnce();

    await expect(manager.read()).resolves.toMatchObject({
      l0_conversations_count: 3,
      total_memories_extracted: 2,
    });
  });

  it("uses the L0 record count instead of capture-batch count", async () => {
    const dataDir = await createDataDir();
    const manager = new CheckpointManager(dataDir);

    await manager.captureAtomically("session", 0, async () => ({ maxTimestamp: 10, messageCount: 3 }));

    await expect(manager.read()).resolves.toMatchObject({ l0_conversations_count: 3, total_processed: 3 });
  });
});
