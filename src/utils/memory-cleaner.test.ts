import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { IMemoryStore } from "../core/store/types.js";
import { CheckpointManager } from "./checkpoint.js";
import { LocalMemoryCleaner } from "./memory-cleaner.js";

const tempDirs: string[] = [];
const NOW = new Date(2026, 6, 21, 12, 0, 0).getTime();

async function makeDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cleaner-test-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "conversations"), { recursive: true });
  await fs.mkdir(path.join(dir, "records"), { recursive: true });
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function seedCheckpoint(dataDir: string, l0: number, l1: number): Promise<CheckpointManager> {
  const manager = new CheckpointManager(dataDir);
  const cp = await manager.read();
  cp.total_processed = l0;
  cp.l0_conversations_count = l0;
  cp.total_memories_extracted = l1;
  cp.memories_since_last_persona = l1;
  await manager.write(cp);
  return manager;
}

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
  await fs.writeFile(
    path.join(dataDir, "conversations", "2026-07-18.jsonl"),
    messages.map((value) => JSON.stringify(value)).join("\n") + "\n",
  );
  await fs.writeFile(
    path.join(dataDir, "records", "2026-07-18.jsonl"),
    memories.map((value) => JSON.stringify(value)).join("\n") + "\n",
  );
}

function healthyStore(overrides: Partial<{
  countL0: () => number | Promise<number>;
  countL1: () => number | Promise<number>;
  deleteL0Expired: () => number | Promise<number>;
  deleteL1Expired: () => number | Promise<number>;
}> = {}): IMemoryStore {
  return {
    isDegraded: () => false,
    countL0: overrides.countL0 ?? (() => 100),
    countL1: overrides.countL1 ?? (() => 50),
    deleteL0Expired: overrides.deleteL0Expired ?? (() => 0),
    deleteL1Expired: overrides.deleteL1Expired ?? (() => 0),
  } as unknown as IMemoryStore;
}

describe("LocalMemoryCleaner checkpoint synchronization", () => {
  it("applies Store deletion counts immediately and never double-counts JSONL deletion", async () => {
    const dataDir = await makeDataDir();
    await writeExpiredShards(dataDir);
    const manager = await seedCheckpoint(dataDir, 100, 50);
    const cleaner = new LocalMemoryCleaner({
      baseDir: dataDir,
      retentionDays: 2,
      cleanTime: "03:00",
      vectorStore: healthyStore({ deleteL0Expired: () => 4, deleteL1Expired: () => 1 }),
    });

    await cleaner.runOnce(NOW);
    const cp = await manager.read();
    expect(cp.total_processed).toBe(96);
    expect(cp.l0_conversations_count).toBe(96);
    expect(cp.total_memories_extracted).toBe(49);
    expect(cp.memories_since_last_persona).toBe(49);
  });

  it("uses valid records in deleted JSONL shards when Store is unavailable", async () => {
    const dataDir = await makeDataDir();
    await writeExpiredShards(dataDir);
    await fs.appendFile(path.join(dataDir, "conversations", "2026-07-18.jsonl"), "bad-json\n");
    const manager = await seedCheckpoint(dataDir, 10, 10);
    const degradedStore = { isDegraded: () => true } as unknown as IMemoryStore;
    const cleaner = new LocalMemoryCleaner({
      baseDir: dataDir,
      retentionDays: 2,
      cleanTime: "03:00",
      vectorStore: degradedStore,
    });

    await cleaner.runOnce(NOW);
    const cp = await manager.read();
    expect(cp.total_processed).toBe(7);
    expect(cp.l0_conversations_count).toBe(7);
    expect(cp.total_memories_extracted).toBe(8);
    expect(cp.memories_since_last_persona).toBe(8);
  });

  it("does not deduct a Store layer whose deletion failed", async () => {
    const dataDir = await makeDataDir();
    await writeExpiredShards(dataDir);
    const manager = await seedCheckpoint(dataDir, 100, 50);
    const cleaner = new LocalMemoryCleaner({
      baseDir: dataDir,
      retentionDays: 2,
      cleanTime: "03:00",
      vectorStore: healthyStore({
        deleteL0Expired: () => { throw new Error("delete failed"); },
        deleteL1Expired: () => 2,
      }),
    });

    await cleaner.runOnce(NOW);
    const cp = await manager.read();
    expect(cp.total_processed).toBe(100);
    expect(cp.l0_conversations_count).toBe(100);
    expect(cp.total_memories_extracted).toBe(48);
  });

  it("does not deduct JSONL records when the shard deletion fails", async () => {
    const dataDir = await makeDataDir();
    await writeExpiredShards(dataDir);
    const manager = await seedCheckpoint(dataDir, 10, 10);
    vi.spyOn(fs, "unlink").mockRejectedValueOnce(new Error("locked file"));
    const cleaner = new LocalMemoryCleaner({
      baseDir: dataDir,
      retentionDays: 2,
      cleanTime: "03:00",
    });

    await cleaner.runOnce(NOW);
    const cp = await manager.read();
    expect(cp.total_processed).toBe(10);
    expect(cp.l0_conversations_count).toBe(10);
    expect(cp.total_memories_extracted).toBe(8);
    await expect(fs.access(path.join(dataDir, "conversations", "2026-07-18.jsonl"))).resolves.toBeUndefined();
  });

  it("preserves concurrent capture and L1 extraction while applying cleanup deltas", async () => {
    const dataDir = await makeDataDir();
    const manager = await seedCheckpoint(dataDir, 100, 50);
    let releaseDeletes!: () => void;
    const deletionGate = new Promise<void>((resolve) => { releaseDeletes = resolve; });
    const cleaner = new LocalMemoryCleaner({
      baseDir: dataDir,
      retentionDays: 2,
      cleanTime: "03:00",
      vectorStore: healthyStore({
        deleteL0Expired: async () => { await deletionGate; return 4; },
        deleteL1Expired: async () => { await deletionGate; return 2; },
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
    expect(cp.total_processed).toBe(99);
    expect(cp.l0_conversations_count).toBe(99);
    expect(cp.total_memories_extracted).toBe(53);
    expect(cp.memories_since_last_persona).toBe(53);
  });
});
