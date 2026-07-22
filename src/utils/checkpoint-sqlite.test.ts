import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { MemoryRecord } from "../core/record/l1-writer.js";
import { VectorStore } from "../core/store/sqlite.js";
import {
  createMockLogger,
  createTempDirFixture,
  seedCheckpoint,
  writeJsonlShard,
} from "../__tests__/helpers/checkpoint-fixtures.js";

const tempDirs = createTempDirFixture("checkpoint-sqlite-test-");
const stores: VectorStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await tempDirs.cleanup();
});

const createDataDir = () => tempDirs.create();

function createStore(dataDir: string): VectorStore {
  const store = new VectorStore(path.join(dataDir, "vectors.db"), 0);
  stores.push(store);
  const result = store.init();
  expect(store.isDegraded(), result.reason).toBe(false);
  return store;
}

function l0Record(id: string, timestamp: number) {
  return {
    id,
    sessionKey: "session",
    sessionId: "conversation",
    role: "user",
    messageText: `message-${id}`,
    recordedAt: new Date(timestamp).toISOString(),
    timestamp,
  };
}

function l1Record(id: string, timestamp: string): MemoryRecord {
  return {
    id,
    content: `memory-${id}`,
    type: "persona",
    priority: 10,
    scene_name: "scene",
    source_message_ids: [],
    metadata: {},
    timestamps: [timestamp],
    createdAt: timestamp,
    updatedAt: timestamp,
    sessionKey: "session",
    sessionId: "conversation",
  };
}

describe("CheckpointManager with real SQLite Store", () => {
  it("strict counts distinguish an empty SQLite Store from a read failure", async () => {
    const dataDir = await createDataDir();
    const store = createStore(dataDir);

    expect(store.readCheckpointCountsStrict("2026-01-01T00:00:00.000Z"))
      .toEqual({ l0: 0, l1: 0, l1Since: 0 });

    store.close();
    expect(() => store.readCheckpointCountsStrict("2026-01-01T00:00:00.000Z")).toThrow();
  });

  it("preserves history and post-persona counts while reconciling SQLite inventory", async () => {
    const dataDir = await createDataDir();
    const store = createStore(dataDir);
    expect(store.upsertL0(l0Record("l0-1", 1), undefined)).toBe(true);
    expect(store.upsertL0(l0Record("l0-2", 2), undefined)).toBe(true);
    expect(store.upsertL0(l0Record("l0-3", 3), undefined)).toBe(true);
    expect(store.upsertL1(l1Record("l1-1", "2026-01-01T00:00:00.000Z"), undefined)).toBe(true);
    expect(store.upsertL1(l1Record("l1-2", "2026-01-02T00:00:00.000Z"), undefined)).toBe(true);

    const manager = await seedCheckpoint(dataDir, {
      total_processed: 100,
      l0_conversations_count: 100,
      total_memories_extracted: 50,
      memories_since_last_persona: 10,
      last_persona_time: "2026-01-01T12:00:00.000Z",
    });

    expect(await manager.recalibrateFromStorage(store, "sqlite-integration-initial"))
      .toEqual({
        source: "store",
        status: "reconciled",
        l0: 3,
        l1: 2,
        memoriesSincePersona: 1,
        changed: true,
      });
    expect(store.deleteL0("l0-1")).toBe(true);
    expect(store.deleteL1("l1-1")).toBe(true);
    expect(await manager.recalibrateFromStorage(store, "sqlite-integration-after-delete"))
      .toEqual({
        source: "store",
        status: "reconciled",
        l0: 2,
        l1: 1,
        memoriesSincePersona: 1,
        changed: true,
      });

    const actual = await manager.read();
    expect(actual.total_processed).toBe(100);
    expect(actual.l0_conversations_count).toBe(2);
    expect(actual.total_memories_extracted).toBe(1);
    expect(actual.memories_since_last_persona).toBe(1);
  });

  it("uses JSONL counts without clearing history when SQLite reads fail", async () => {
    const dataDir = await createDataDir();
    const store = createStore(dataDir);
    expect(store.upsertL0(l0Record("l0-1", 1), undefined)).toBe(true);
    expect(store.upsertL1(l1Record("l1-1", "2026-01-01T00:00:00.000Z"), undefined)).toBe(true);

    await writeJsonlShard(dataDir, "conversations", "2026-01-01.jsonl", [
      { sessionKey: "session", role: "user", content: "message", timestamp: 1 },
    ]);
    await writeJsonlShard(dataDir, "records", "2026-01-01.jsonl", [
      { id: "l1-old", sessionKey: "session", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "l1-recent", sessionKey: "session", updatedAt: "2026-01-02T00:00:00.000Z" },
    ]);

    const logger = createMockLogger();
    const manager = await seedCheckpoint(dataDir, {
      total_processed: 500,
      l0_conversations_count: 20,
      total_memories_extracted: 50,
      memories_since_last_persona: 10,
      last_persona_time: "2026-01-01T12:00:00.000Z",
    }, logger);
    store.close();

    // Ordinary Store reads remain fault-tolerant and ambiguous after close.
    expect(store.countL0()).toBe(0);
    expect(store.countL1()).toBe(0);
    expect(store.queryL1Records()).toEqual([]);

    const result = await manager.recalibrateFromStorage(store, "sqlite-closed");
    const actual = await manager.read();
    expect(result).toEqual({
      source: "jsonl",
      status: "reconciled",
      l0: 1,
      l1: 2,
      memoriesSincePersona: 1,
      changed: true,
    });
    expect(actual.total_processed).toBe(500);
    expect(actual.l0_conversations_count).toBe(1);
    expect(actual.total_memories_extracted).toBe(2);
    expect(actual.memories_since_last_persona).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("falling back to JSONL"));
  });
});
