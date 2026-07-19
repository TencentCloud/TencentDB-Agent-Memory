import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointManager, type Checkpoint } from "./checkpoint.js";
import type { IMemoryStore } from "../core/store/types.js";

const tempDirs: string[] = [];

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
    l0_conversations_count: 0,
    total_memories_extracted: 0,
    ...overrides,
  };
}

async function makeTempDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-checkpoint-"));
  tempDirs.push(dir);
  return dir;
}

async function writeJsonlLines(dir: string, fileName: string, count: number): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const lines = Array.from({ length: count }, (_, i) => JSON.stringify({ id: i }));
  await fs.writeFile(path.join(dir, fileName), `${lines.join("\n")}\n`, "utf-8");
}

function makeVectorStore(params: {
  countL0: () => number | Promise<number>;
  degraded?: boolean;
}): IMemoryStore {
  return {
    isDegraded: () => params.degraded ?? false,
    countL0: params.countL0,
  } as unknown as IMemoryStore;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("CheckpointManager.recalibrate", () => {
  it("overwrites drifted counters from real storage without touching split session states", async () => {
    const dataDir = await makeTempDataDir();
    const manager = new CheckpointManager(dataDir);
    const runnerStates = {
      "session-a": {
        last_captured_timestamp: 123,
        last_l1_cursor: 456,
        last_scene_name: "planning",
      },
    };
    const pipelineStates = {
      "session-a": {
        conversation_count: 3,
        last_extraction_time: "2026-01-01T00:00:00.000Z",
        last_extraction_updated_time: "2026-01-01T00:01:00.000Z",
        last_active_time: 789,
        l2_pending_l1_count: 2,
        warmup_threshold: 4,
        l2_last_extraction_time: "2026-01-01T00:02:00.000Z",
      },
    };

    await manager.write(makeCheckpoint({
      total_memories_extracted: 50,
      l0_conversations_count: 50,
      runner_states: runnerStates,
      pipeline_states: pipelineStates,
    }));
    await writeJsonlLines(path.join(dataDir, "records"), "2026-01-01.jsonl", 42);
    await writeJsonlLines(path.join(dataDir, "conversations"), "2026-01-01.jsonl", 9);

    await manager.recalibrate({ vectorStore: makeVectorStore({ countL0: () => 17 }) });

    const cp = await manager.read();
    expect(cp.total_memories_extracted).toBe(42);
    expect(cp.l0_conversations_count).toBe(17);
    expect(cp.runner_states).toEqual(runnerStates);
    expect(cp.pipeline_states).toEqual(pipelineStates);
  });

  it("falls back to conversations JSONL when vectorStore countL0 fails", async () => {
    const dataDir = await makeTempDataDir();
    const manager = new CheckpointManager(dataDir);

    await manager.write(makeCheckpoint({
      total_memories_extracted: 50,
      l0_conversations_count: 50,
    }));
    await writeJsonlLines(path.join(dataDir, "records"), "2026-01-01.jsonl", 2);
    await fs.mkdir(path.join(dataDir, "conversations"), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "conversations", "2026-01-01.jsonl"),
      '{"id":1}\n\n{"id":2}\r\n   \n{"id":3}\n',
      "utf-8",
    );

    await manager.recalibrate({
      vectorStore: makeVectorStore({
        countL0: () => {
          throw new Error("db unavailable");
        },
      }),
    });

    const cp = await manager.read();
    expect(cp.total_memories_extracted).toBe(2);
    expect(cp.l0_conversations_count).toBe(3);
  });

  it("falls back to zero when records and conversations directories do not exist", async () => {
    const dataDir = await makeTempDataDir();
    const manager = new CheckpointManager(dataDir);

    await manager.write(makeCheckpoint({
      total_memories_extracted: 50,
      l0_conversations_count: 50,
    }));

    await manager.recalibrate();

    const cp = await manager.read();
    expect(cp.total_memories_extracted).toBe(0);
    expect(cp.l0_conversations_count).toBe(0);
  });
});

describe("CheckpointManager.captureAtomically", () => {
  it("increments l0_conversations_count by captured message rows", async () => {
    const dataDir = await makeTempDataDir();
    const manager = new CheckpointManager(dataDir);

    await manager.captureAtomically("session-a", undefined, async () => ({
      maxTimestamp: 123,
      messageCount: 3,
    }));

    const cp = await manager.read();
    expect(cp.total_processed).toBe(3);
    expect(cp.l0_conversations_count).toBe(3);
  });
});
