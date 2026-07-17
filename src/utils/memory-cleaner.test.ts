import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../core/types.js";
import type { IMemoryStore } from "../core/store/types.js";
import { CheckpointManager } from "./checkpoint.js";
import { LocalMemoryCleaner } from "./memory-cleaner.js";
import { initTimeModule, _resetTimeModuleForTest } from "./time.js";

const tempDirs: string[] = [];
const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-cleaner-"));
  tempDirs.push(dir);
  return dir;
}

async function writeShard(
  baseDir: string,
  subdirectory: "conversations" | "records",
  date: string,
  lines: string[],
): Promise<void> {
  const directory = path.join(baseDir, subdirectory);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${date}.jsonl`), `${lines.join("\n")}\n`, "utf-8");
}

function l0Line(id: string, recordedAt: string): string {
  return JSON.stringify({ id, sessionKey: "session", recordedAt });
}

function l1Line(id: string, updatedAt: string): string {
  return JSON.stringify({ id, sessionKey: "session", updatedAt });
}

afterEach(async () => {
  _resetTimeModuleForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("LocalMemoryCleaner checkpoint updates", () => {
  it("uses successful store deletion counts and only subtracts post-persona L1 rows", async () => {
    initTimeModule({ timezone: "UTC" });
    const baseDir = await makeTempDir();
    const checkpoint = new CheckpointManager(baseDir);
    await checkpoint.recalculateCounts({
      l0Records: 60,
      l1Records: 25,
      l1RecordsSincePersona: 10,
    });
    const seeded = await checkpoint.read();
    seeded.last_persona_time = "2026-07-10T00:00:00.000Z";
    await checkpoint.write(seeded);

    const queryL1Records = vi.fn(() => [
      { updated_time: "2026-07-12T12:00:00.000Z" },
      { updated_time: "2026-07-13T12:00:00.000Z" },
      { updated_time: "2026-07-15T12:00:00.000Z" },
    ]);
    const store = {
      isDegraded: () => false,
      countL0: () => 60,
      countL1: () => 25,
      queryL1Records,
      deleteL0Expired: () => 8,
      deleteL1Expired: () => 3,
    } as Partial<IMemoryStore> as IMemoryStore;

    const cleaner = new LocalMemoryCleaner({
      baseDir,
      retentionDays: 2,
      cleanTime: "03:00",
      logger,
      vectorStore: store,
    });
    await cleaner.runOnce(Date.parse("2026-07-15T12:00:00.000Z"));

    expect(queryL1Records).toHaveBeenCalledWith({
      updatedAfter: "2026-07-10T00:00:00.000Z",
    });
    expect(await checkpoint.read()).toMatchObject({
      total_processed: 52,
      l0_conversations_count: 52,
      total_memories_extracted: 22,
      memories_since_last_persona: 8,
    });
  });

  it("uses deleted JSONL records and preserves pending persona count for older history", async () => {
    initTimeModule({ timezone: "UTC" });
    const baseDir = await makeTempDir();
    const checkpoint = new CheckpointManager(baseDir);
    await checkpoint.recalculateCounts({
      l0Records: 3,
      l1Records: 3,
      l1RecordsSincePersona: 1,
    });
    const seeded = await checkpoint.read();
    seeded.last_persona_time = "2026-07-13T00:00:00.000Z";
    await checkpoint.write(seeded);

    await writeShard(baseDir, "conversations", "2026-07-12", [
      l0Line("old-l0-1", "2026-07-12T12:00:00.000Z"),
      l0Line("old-l0-2", "2026-07-12T12:01:00.000Z"),
      "{bad-json",
    ]);
    await writeShard(baseDir, "conversations", "2026-07-15", [
      l0Line("new-l0", "2026-07-15T12:00:00.000Z"),
    ]);
    await writeShard(baseDir, "records", "2026-07-12", [
      l1Line("old-l1-1", "2026-07-12T12:00:00.000Z"),
      l1Line("old-l1-2", "2026-07-12T12:01:00.000Z"),
      JSON.stringify({ id: "incomplete" }),
    ]);
    await writeShard(baseDir, "records", "2026-07-15", [
      l1Line("new-l1", "2026-07-15T12:00:00.000Z"),
    ]);

    const cleaner = new LocalMemoryCleaner({
      baseDir,
      retentionDays: 2,
      cleanTime: "03:00",
      logger,
    });
    await cleaner.runOnce(Date.parse("2026-07-15T12:00:00.000Z"));

    expect(await checkpoint.read()).toMatchObject({
      total_processed: 1,
      l0_conversations_count: 1,
      total_memories_extracted: 1,
      memories_since_last_persona: 1,
    });
    await expect(fs.access(path.join(baseDir, "records", "2026-07-12.jsonl"))).rejects.toThrow();
    await expect(fs.access(path.join(baseDir, "records", "2026-07-15.jsonl"))).resolves.toBeUndefined();
  });

  it("uses JSONL deletion counts when the configured store is degraded", async () => {
    initTimeModule({ timezone: "UTC" });
    const baseDir = await makeTempDir();
    const checkpoint = new CheckpointManager(baseDir);
    await checkpoint.recalculateCounts({
      l0Records: 2,
      l1Records: 2,
      l1RecordsSincePersona: 2,
    });
    await writeShard(baseDir, "conversations", "2026-07-12", [
      l0Line("old-l0", "2026-07-12T12:00:00.000Z"),
    ]);
    await writeShard(baseDir, "records", "2026-07-12", [
      l1Line("old-l1", "2026-07-12T12:00:00.000Z"),
    ]);

    const deleteL0Expired = vi.fn();
    const store = {
      isDegraded: () => true,
      deleteL0Expired,
    } as Partial<IMemoryStore> as IMemoryStore;
    const cleaner = new LocalMemoryCleaner({
      baseDir,
      retentionDays: 2,
      cleanTime: "03:00",
      logger,
      vectorStore: store,
    });
    await cleaner.runOnce(Date.parse("2026-07-15T12:00:00.000Z"));

    expect(deleteL0Expired).not.toHaveBeenCalled();
    expect(await checkpoint.read()).toMatchObject({
      total_processed: 1,
      l0_conversations_count: 1,
      total_memories_extracted: 1,
      memories_since_last_persona: 1,
    });
  });
});
