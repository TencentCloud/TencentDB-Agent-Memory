import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemoryRecord } from "../core/record/l1-writer.js";
import { VectorStore } from "../core/store/sqlite.js";
import { CheckpointManager } from "./checkpoint.js";

const tempDirs: string[] = [];
const stores: VectorStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createDataDir(): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-sqlite-test-"));
  tempDirs.push(dataDir);
  return dataDir;
}

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
  it("recalibrates from real SQLite counts before and after records are deleted", async () => {
    const dataDir = await createDataDir();
    const store = createStore(dataDir);
    expect(store.upsertL0(l0Record("l0-1", 1), undefined)).toBe(true);
    expect(store.upsertL0(l0Record("l0-2", 2), undefined)).toBe(true);
    expect(store.upsertL0(l0Record("l0-3", 3), undefined)).toBe(true);
    expect(store.upsertL1(l1Record("l1-1", "2026-01-01T00:00:00.000Z"), undefined)).toBe(true);
    expect(store.upsertL1(l1Record("l1-2", "2026-01-02T00:00:00.000Z"), undefined)).toBe(true);

    const manager = new CheckpointManager(dataDir);
    const stale = await manager.read();
    stale.total_processed = 100;
    stale.l0_conversations_count = 100;
    stale.total_memories_extracted = 100;
    stale.memories_since_last_persona = 100;
    await manager.write(stale);

    expect(await manager.recalibrateFromStorage(store, "sqlite-integration-initial"))
      .toEqual({ source: "store", l0: 3, l1: 2, memoriesSincePersona: 2 });
    expect(store.deleteL0("l0-1")).toBe(true);
    expect(store.deleteL1("l1-1")).toBe(true);
    expect(await manager.recalibrateFromStorage(store, "sqlite-integration-after-delete"))
      .toEqual({ source: "store", l0: 2, l1: 1, memoriesSincePersona: 1 });

    const actual = await manager.read();
    expect(actual.total_processed).toBe(2);
    expect(actual.l0_conversations_count).toBe(2);
    expect(actual.total_memories_extracted).toBe(1);
    expect(actual.memories_since_last_persona).toBe(1);
  });

  it("falls back to JSONL instead of clearing a nonzero checkpoint after SQLite is closed", async () => {
    const dataDir = await createDataDir();
    const store = createStore(dataDir);
    expect(store.upsertL0(l0Record("l0-1", 1), undefined)).toBe(true);
    expect(store.upsertL1(l1Record("l1-1", "2026-01-01T00:00:00.000Z"), undefined)).toBe(true);

    await fs.mkdir(path.join(dataDir, "conversations"), { recursive: true });
    await fs.mkdir(path.join(dataDir, "records"), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "conversations", "2026-01-01.jsonl"),
      JSON.stringify({ sessionKey: "session", role: "user", content: "message", timestamp: 1 }) + "\n",
    );
    await fs.writeFile(
      path.join(dataDir, "records", "2026-01-01.jsonl"),
      JSON.stringify({ id: "l1-1", sessionKey: "session", createdAt: "2026-01-01T00:00:00.000Z" }) + "\n",
    );

    const logger = { info: vi.fn(), warn: vi.fn() };
    const manager = new CheckpointManager(dataDir, logger);
    const checkpoint = await manager.read();
    checkpoint.total_processed = 1;
    checkpoint.l0_conversations_count = 1;
    checkpoint.total_memories_extracted = 1;
    checkpoint.memories_since_last_persona = 1;
    await manager.write(checkpoint);
    store.close();

    // Ordinary Store reads remain fault-tolerant and ambiguous after close.
    expect(store.countL0()).toBe(0);
    expect(store.countL1()).toBe(0);
    expect(store.queryL1Records()).toEqual([]);

    const result = await manager.recalibrateFromStorage(store, "sqlite-closed");
    const actual = await manager.read();
    expect(result).toEqual({ source: "jsonl", l0: 1, l1: 1, memoriesSincePersona: 1 });
    expect(actual.total_processed).toBe(1);
    expect(actual.l0_conversations_count).toBe(1);
    expect(actual.total_memories_extracted).toBe(1);
    expect(actual.memories_since_last_persona).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("falling back to JSONL"));
  });
});
