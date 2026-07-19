import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CheckpointManager } from "./checkpoint.js";
import { LocalMemoryCleaner } from "./memory-cleaner.js";
import type { Checkpoint } from "./checkpoint.js";
import type { IMemoryStore } from "../core/store/types.js";

const tempDirs: string[] = [];

async function makeDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-tdai-cleaner-"));
  tempDirs.push(dir);
  return dir;
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
    l0_conversations_count: 100,
    total_memories_extracted: 40,
    ...overrides,
  };
}

function makeCleaningStore(): IMemoryStore {
  let l0CountCalls = 0;
  let l1CountCalls = 0;

  return {
    isDegraded: () => false,
    countL0: () => {
      l0CountCalls += 1;
      return l0CountCalls === 1 ? 100 : 4;
    },
    countL1: () => {
      l1CountCalls += 1;
      return l1CountCalls === 1 ? 40 : 2;
    },
    deleteL0Expired: () => 96,
    deleteL1Expired: () => 38,
  } as unknown as IMemoryStore;
}

describe("LocalMemoryCleaner checkpoint counter refresh", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("recalculates checkpoint counters after automatic cleanup", async () => {
    const dataDir = await makeDataDir();
    const checkpoint = new CheckpointManager(dataDir);
    await checkpoint.write(makeCheckpoint());

    const cleaner = new LocalMemoryCleaner({
      baseDir: dataDir,
      retentionDays: 2,
      cleanTime: "03:00",
      vectorStore: makeCleaningStore(),
      logger: {
        info() {},
        warn() {},
        error() {},
      },
    });

    await cleaner.runOnce(new Date("2026-01-03T12:00:00Z").getTime());

    const actual = await checkpoint.read();
    expect(actual.l0_conversations_count).toBe(4);
    expect(actual.total_memories_extracted).toBe(2);
  });
});
