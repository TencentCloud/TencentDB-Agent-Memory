import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { IMemoryStore } from "../core/store/types.js";
import type { Logger } from "../core/types.js";
import { CheckpointManager } from "./checkpoint.js";
import { LocalMemoryCleaner } from "./memory-cleaner.js";
import { _resetTimeModuleForTest, initTimeModule } from "./time.js";

const tempDirectories: string[] = [];
const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

async function makeTempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-cleaner-"));
  tempDirectories.push(directory);
  return directory;
}

async function seedCheckpoint(
  baseDir: string,
  counts: { l0: number; l1: number; sincePersona: number },
): Promise<CheckpointManager> {
  const checkpoint = new CheckpointManager(baseDir);
  await checkpoint.write({
    last_captured_timestamp: 0,
    total_processed: counts.l0,
    last_persona_at: 0,
    last_persona_time: "2026-07-10T00:00:00.000Z",
    request_persona_update: false,
    persona_update_reason: "",
    memories_since_last_persona: counts.sincePersona,
    scenes_processed: 0,
    runner_states: {},
    pipeline_states: {},
    l0_conversations_count: counts.l0,
    total_memories_extracted: counts.l1,
  });
  return checkpoint;
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
  await Promise.all(
    tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("LocalMemoryCleaner checkpoint updates", () => {
  it("uses store deletion deltas and keeps the Persona-relative count exact", async () => {
    initTimeModule({ timezone: "UTC" });
    const baseDir = await makeTempDirectory();
    const checkpoint = await seedCheckpoint(baseDir, { l0: 60, l1: 25, sincePersona: 5 });

    const store = {
      isDegraded: () => false,
      getCheckpointCounts: () => ({
        l0Records: 60,
        l1Records: 25,
        filteredL1Records: 1,
      }),
      deleteL0Expired: () => 8,
      deleteL1Expired: () => 3,
    } as Partial<IMemoryStore> as IMemoryStore;

    await new LocalMemoryCleaner({
      baseDir,
      retentionDays: 2,
      cleanTime: "03:00",
      logger,
      vectorStore: store,
    }).runOnce(Date.parse("2026-07-15T12:00:00.000Z"));

    expect(await checkpoint.read()).toMatchObject({
      total_processed: 52,
      l0_conversations_count: 52,
      total_memories_extracted: 22,
      memories_since_last_persona: 4,
    });
  });

  it("uses valid deleted JSONL records when no store is available", async () => {
    initTimeModule({ timezone: "UTC" });
    const baseDir = await makeTempDirectory();
    const checkpoint = await seedCheckpoint(baseDir, { l0: 3, l1: 3, sincePersona: 2 });

    await writeShard(baseDir, "conversations", "2026-07-12", [
      l0Line("old-l0-1", "2026-07-12T12:00:00.000Z"),
      l0Line("old-l0-2", "2026-07-12T12:01:00.000Z"),
      "{bad-json",
    ]);
    await writeShard(baseDir, "conversations", "2026-07-15", [
      l0Line("new-l0", "2026-07-15T12:00:00.000Z"),
    ]);
    await writeShard(baseDir, "records", "2026-07-12", [
      l1Line("old-before-persona", "2026-07-09T12:00:00.000Z"),
      l1Line("old-after-persona", "2026-07-12T12:00:00.000Z"),
      JSON.stringify({ id: "incomplete" }),
    ]);
    await writeShard(baseDir, "records", "2026-07-15", [
      l1Line("new-l1", "2026-07-15T12:00:00.000Z"),
    ]);

    await new LocalMemoryCleaner({
      baseDir,
      retentionDays: 2,
      cleanTime: "03:00",
      logger,
    }).runOnce(Date.parse("2026-07-15T12:00:00.000Z"));

    expect(await checkpoint.read()).toMatchObject({
      total_processed: 1,
      l0_conversations_count: 1,
      total_memories_extracted: 1,
      memories_since_last_persona: 1,
    });
    await expect(fs.access(path.join(baseDir, "records", "2026-07-12.jsonl"))).rejects.toThrow();
    await expect(fs.access(path.join(baseDir, "records", "2026-07-15.jsonl"))).resolves.toBeUndefined();
  });
});
