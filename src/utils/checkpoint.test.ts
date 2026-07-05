import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CheckpointManager } from "./checkpoint.js";
import type { Checkpoint } from "./checkpoint.js";
import type { IMemoryStore } from "../core/store/types.js";

const tempDirs: string[] = [];

async function makeDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-tdai-checkpoint-"));
  tempDirs.push(dir);
  return dir;
}

async function writeJsonl(filePath: string, rows: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf-8",
  );
}

function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    last_captured_timestamp: 0,
    total_processed: 0,
    last_persona_at: 0,
    last_persona_time: "",
    request_persona_update: false,
    persona_update_reason: "",
    memories_since_last_persona: 0,
    scenes_processed: 0,
    runner_states: {},
    pipeline_states: {},
    l0_conversations_count: 999,
    total_memories_extracted: 888,
    ...overrides,
  };
}

function makeStore(params: {
  l0: number;
  l1: number;
  degraded?: boolean;
}): IMemoryStore {
  return {
    isDegraded: () => params.degraded ?? false,
    countL0: () => params.l0,
    countL1: () => params.l1,
  } as unknown as IMemoryStore;
}

describe("CheckpointManager counter recalculation", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("recalculates counters from JSONL files when no vector store is available", async () => {
    const dataDir = await makeDataDir();
    const checkpoint = new CheckpointManager(dataDir);
    await checkpoint.write(makeCheckpoint());

    await writeJsonl(path.join(dataDir, "conversations", "2026-01-01.jsonl"), [
      { id: "l0-1", content: "first" },
      { id: "l0-2", content: "second" },
    ]);
    await writeJsonl(path.join(dataDir, "records", "2026-01-01.jsonl"), [
      { id: "l1-1", content: "memory" },
    ]);

    await checkpoint.recalculateCounters();

    const actual = await checkpoint.read();
    expect(actual.l0_conversations_count).toBe(2);
    expect(actual.total_memories_extracted).toBe(1);
  });

  it("prefers vector store counts over JSONL counts", async () => {
    const dataDir = await makeDataDir();
    const checkpoint = new CheckpointManager(dataDir);
    await checkpoint.write(makeCheckpoint());

    await writeJsonl(path.join(dataDir, "conversations", "2026-01-01.jsonl"), [
      { id: "l0-jsonl" },
    ]);
    await writeJsonl(path.join(dataDir, "records", "2026-01-01.jsonl"), [
      { id: "l1-jsonl" },
    ]);

    await checkpoint.recalculateCounters(makeStore({ l0: 7, l1: 3 }));

    const actual = await checkpoint.read();
    expect(actual.l0_conversations_count).toBe(7);
    expect(actual.total_memories_extracted).toBe(3);
  });

  it("falls back to JSONL counts when vector store is degraded", async () => {
    const dataDir = await makeDataDir();
    const checkpoint = new CheckpointManager(dataDir);
    await checkpoint.write(makeCheckpoint());

    await writeJsonl(path.join(dataDir, "conversations", "2026-01-01.jsonl"), [
      { id: "l0-1" },
      { id: "l0-2" },
    ]);
    await writeJsonl(path.join(dataDir, "records", "2026-01-01.jsonl"), [
      { id: "l1-1" },
    ]);

    await checkpoint.recalculateCounters(makeStore({ l0: 100, l1: 50, degraded: true }));

    const actual = await checkpoint.read();
    expect(actual.l0_conversations_count).toBe(2);
    expect(actual.total_memories_extracted).toBe(1);
  });

  it("reflects manual JSONL deletion after recalculation", async () => {
    const dataDir = await makeDataDir();
    const checkpoint = new CheckpointManager(dataDir);
    const l0Path = path.join(dataDir, "conversations", "2026-01-01.jsonl");
    const l1Path = path.join(dataDir, "records", "2026-01-01.jsonl");

    await checkpoint.write(makeCheckpoint({ l0_conversations_count: 5, total_memories_extracted: 4 }));
    await writeJsonl(l0Path, [{ id: "l0-1" }, { id: "l0-2" }]);
    await writeJsonl(l1Path, [{ id: "l1-1" }]);
    await fs.rm(l0Path);

    await checkpoint.recalculateCounters();

    const actual = await checkpoint.read();
    expect(actual.l0_conversations_count).toBe(0);
    expect(actual.total_memories_extracted).toBe(1);
  });
});
