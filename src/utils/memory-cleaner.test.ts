import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { IMemoryStore } from "../core/store/types.js";
import { CheckpointManager } from "./checkpoint.js";
import { LocalMemoryCleaner } from "./memory-cleaner.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-tdai-cleaner-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("LocalMemoryCleaner checkpoint reconciliation", () => {
  it("recalculates retained L0/L1 counts after vector-store cleanup", async () => {
    const baseDir = await createTempDir();
    const checkpoint = new CheckpointManager(baseDir);
    const initial = await checkpoint.read();
    await checkpoint.write({
      ...initial,
      l0_conversations_count: 900,
      total_memories_extracted: 800,
    });

    let l0Count = 70;
    let l1Count = 40;
    const vectorStore = {
      countL0: async () => l0Count,
      countL1: async () => l1Count,
      deleteL0Expired: async () => {
        l0Count -= 12;
        return 12;
      },
      deleteL1Expired: async () => {
        l1Count -= 9;
        return 9;
      },
    } as unknown as IMemoryStore;

    const cleaner = new LocalMemoryCleaner({
      baseDir,
      retentionDays: 3,
      cleanTime: "03:00",
      vectorStore,
    });

    await cleaner.runOnce(new Date("2026-07-22T12:00:00.000Z").getTime());

    const state = await checkpoint.read();
    expect(state.l0_conversations_count).toBe(58);
    expect(state.total_memories_extracted).toBe(31);
  });
});
