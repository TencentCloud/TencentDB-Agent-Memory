import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { IMemoryStore } from "../core/store/types.js";
import {
  createMemoryStoreMock,
  createTempDirFixture,
  seedCheckpoint,
  writeJsonlShard,
} from "../__tests__/helpers/checkpoint-fixtures.js";
import { LocalMemoryCleaner } from "./memory-cleaner.js";

const tempDirs = createTempDirFixture("cleaner-test-");
const NOW = new Date(2026, 6, 21, 12, 0, 0).getTime();
const CHECKPOINT_SEED = {
  total_processed: 500,
  l0_conversations_count: 100,
  total_memories_extracted: 50,
  memories_since_last_persona: 10,
  last_persona_time: "2026-07-21T06:00:00.000Z",
};

const makeDataDir = () => tempDirs.create(true);

afterEach(async () => {
  await tempDirs.cleanup();
});

async function writeExpiredShards(dataDir: string): Promise<void> {
  const messages = [
    { sessionKey: "s", role: "user", content: "one", timestamp: 1 },
    { sessionKey: "s", role: "assistant", content: "two", timestamp: 2 },
    { sessionKey: "s", role: "user", content: "three", timestamp: 3 },
  ];
  const memories = [
    { id: "m1", sessionKey: "s", createdAt: "2026-07-18T00:00:00.000Z" },
    { id: "m2", sessionKey: "s", updatedAt: "2026-07-18T01:00:00.000Z" },
  ];
  const retainedMemories = [
    ...Array.from({ length: 38 }, (_, index) => ({
      id: `retained-old-${index}`,
      sessionKey: "s",
      updatedAt: "2026-07-21T01:00:00.000Z",
    })),
    ...Array.from({ length: 10 }, (_, index) => ({
      id: `retained-recent-${index}`,
      sessionKey: "s",
      updatedAt: "2026-07-21T08:00:00.000Z",
    })),
  ];
  await writeJsonlShard(dataDir, "conversations", "2026-07-18.jsonl", messages);
  await writeJsonlShard(dataDir, "records", "2026-07-18.jsonl", memories);
  await writeJsonlShard(dataDir, "records", "2026-07-21.jsonl", retainedMemories);
}

function healthyStore(overrides: Partial<{
  countL0: () => number | Promise<number>;
  countL1: () => number | Promise<number>;
  deleteL0Expired: () => number | Promise<number>;
  deleteL1Expired: () => number | Promise<number>;
  readCheckpointCountsStrict: () =>
    | { l0: number; l1: number; l1Since: number }
    | Promise<{ l0: number; l1: number; l1Since: number }>;
}> = {}): IMemoryStore {
  return createMemoryStoreMock({
    countL0: overrides.countL0 ?? (() => 100),
    countL1: overrides.countL1 ?? (() => 50),
    deleteL0Expired: overrides.deleteL0Expired ?? (() => 0),
    deleteL1Expired: overrides.deleteL1Expired ?? (() => 0),
    ...(overrides.readCheckpointCountsStrict
      ? { readCheckpointCountsStrict: overrides.readCheckpointCountsStrict }
      : {}),
  });
}

describe("LocalMemoryCleaner checkpoint synchronization", () => {
  it("updates counters from actual Store deletions without double-counting JSONL", async () => {
    const dataDir = await makeDataDir();
    await writeExpiredShards(dataDir);
    const manager = await seedCheckpoint(dataDir, CHECKPOINT_SEED);
    const cleaner = new LocalMemoryCleaner({
      baseDir: dataDir,
      retentionDays: 2,
      cleanTime: "03:00",
      vectorStore: healthyStore({
        deleteL0Expired: () => 4,
        deleteL1Expired: () => 1,
        readCheckpointCountsStrict: () => ({ l0: 96, l1: 49, l1Since: 10 }),
      }),
    });

    await cleaner.runOnce(NOW);
    const cp = await manager.read();
    expect(cp.total_processed).toBe(500);
    expect(cp.l0_conversations_count).toBe(96);
    expect(cp.total_memories_extracted).toBe(49);
    expect(cp.memories_since_last_persona).toBe(10);
  });

  it("subtracts valid records from deleted JSONL shards when Store is unavailable", async () => {
    const dataDir = await makeDataDir();
    await writeExpiredShards(dataDir);
    await fs.appendFile(path.join(dataDir, "conversations", "2026-07-18.jsonl"), "bad-json\n");
    const manager = await seedCheckpoint(dataDir, CHECKPOINT_SEED);
    const degradedStore = createMemoryStoreMock({ isDegraded: () => true });
    const cleaner = new LocalMemoryCleaner({
      baseDir: dataDir,
      retentionDays: 2,
      cleanTime: "03:00",
      vectorStore: degradedStore,
    });

    await cleaner.runOnce(NOW);
    const cp = await manager.read();
    expect(cp.total_processed).toBe(500);
    expect(cp.l0_conversations_count).toBe(97);
    expect(cp.total_memories_extracted).toBe(48);
    expect(cp.memories_since_last_persona).toBe(10);
  });

  it("preserves a failed Store layer while applying successful deletions", async () => {
    const dataDir = await makeDataDir();
    await writeExpiredShards(dataDir);
    const manager = await seedCheckpoint(dataDir, CHECKPOINT_SEED);
    const cleaner = new LocalMemoryCleaner({
      baseDir: dataDir,
      retentionDays: 2,
      cleanTime: "03:00",
      vectorStore: healthyStore({
        deleteL0Expired: () => { throw new Error("delete failed"); },
        deleteL1Expired: () => 2,
        readCheckpointCountsStrict: () => ({ l0: 100, l1: 48, l1Since: 10 }),
      }),
    });

    await cleaner.runOnce(NOW);
    const cp = await manager.read();
    expect(cp.total_processed).toBe(500);
    expect(cp.l0_conversations_count).toBe(100);
    expect(cp.total_memories_extracted).toBe(48);
    expect(cp.memories_since_last_persona).toBe(10);
  });

  it("preserves counts for a JSONL shard that could not be deleted", async () => {
    const dataDir = await makeDataDir();
    await writeExpiredShards(dataDir);
    const manager = await seedCheckpoint(dataDir, CHECKPOINT_SEED);
    vi.spyOn(fs, "unlink").mockRejectedValueOnce(new Error("locked file"));
    const cleaner = new LocalMemoryCleaner({
      baseDir: dataDir,
      retentionDays: 2,
      cleanTime: "03:00",
    });

    await cleaner.runOnce(NOW);
    const cp = await manager.read();
    expect(cp.total_processed).toBe(500);
    expect(cp.l0_conversations_count).toBe(100);
    expect(cp.total_memories_extracted).toBe(48);
    expect(cp.memories_since_last_persona).toBe(10);
    await expect(fs.access(path.join(dataDir, "conversations", "2026-07-18.jsonl"))).resolves.toBeUndefined();
  });

  it("preserves captures and extractions that complete during cleanup", async () => {
    const dataDir = await makeDataDir();
    const manager = await seedCheckpoint(dataDir, CHECKPOINT_SEED);
    let releaseDeletes!: () => void;
    const deletionGate = new Promise<void>((resolve) => { releaseDeletes = resolve; });
    const cleaner = new LocalMemoryCleaner({
      baseDir: dataDir,
      retentionDays: 2,
      cleanTime: "03:00",
      vectorStore: healthyStore({
        deleteL0Expired: async () => { await deletionGate; return 4; },
        deleteL1Expired: async () => { await deletionGate; return 2; },
        readCheckpointCountsStrict: () => ({ l0: 97, l1: 53, l1Since: 15 }),
      }),
    });

    const cleanup = cleaner.runOnce(NOW);
    await Promise.all([
      manager.captureAtomically("s", undefined, async () => ({ maxTimestamp: 10, messageCount: 3 })),
      manager.markL1ExtractionComplete("s", 5, 11, "scene"),
    ]);
    releaseDeletes();
    await cleanup;

    const cp = await manager.read();
    expect(cp.total_processed).toBe(503);
    expect(cp.l0_conversations_count).toBe(97);
    expect(cp.total_memories_extracted).toBe(53);
    expect(cp.memories_since_last_persona).toBe(15);
  });
});
