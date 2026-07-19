import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointManager } from "./checkpoint.js";

const tmpDirs: string[] = [];

async function makeDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-checkpoint-"));
  tmpDirs.push(dir);
  return dir;
}

async function writeJsonl(filePath: string, records: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf-8");
}

describe("CheckpointManager.recalibrateCounters", () => {
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("recounts L0 and L1 counters from JSONL when no vector store is available", async () => {
    const dataDir = await makeDataDir();
    const checkpoint = new CheckpointManager(dataDir);

    await checkpoint.write({
      last_captured_timestamp: 0,
      total_processed: 0,
      last_persona_at: 0,
      last_persona_time: "",
      request_persona_update: false,
      persona_update_reason: "",
      memories_since_last_persona: 99,
      scenes_processed: 0,
      runner_states: {},
      pipeline_states: {},
      l0_conversations_count: 20,
      total_memories_extracted: 10,
    });
    await writeJsonl(path.join(dataDir, "conversations", "2026-07-01.jsonl"), [
      { id: "l0-1" },
      { id: "l0-2" },
      { id: "l0-3" },
    ]);
    await writeJsonl(path.join(dataDir, "records", "2026-07-01.jsonl"), [
      { id: "l1-1" },
      { id: "l1-2" },
    ]);

    await checkpoint.recalibrateCounters();

    const cp = await checkpoint.read();
    expect(cp.l0_conversations_count).toBe(3);
    expect(cp.total_memories_extracted).toBe(2);
    expect(cp.memories_since_last_persona).toBe(2);
  });

  it("prefers vector store counts over JSONL fallbacks when available", async () => {
    const dataDir = await makeDataDir();
    const checkpoint = new CheckpointManager(dataDir);

    await checkpoint.write({
      last_captured_timestamp: 0,
      total_processed: 0,
      last_persona_at: 0,
      last_persona_time: "",
      request_persona_update: false,
      persona_update_reason: "",
      memories_since_last_persona: 1,
      scenes_processed: 0,
      runner_states: {},
      pipeline_states: {},
      l0_conversations_count: 100,
      total_memories_extracted: 100,
    });
    await writeJsonl(path.join(dataDir, "conversations", "2026-07-01.jsonl"), [{ id: "jsonl-l0" }]);
    await writeJsonl(path.join(dataDir, "records", "2026-07-01.jsonl"), [{ id: "jsonl-l1" }]);

    await checkpoint.recalibrateCounters({
      vectorStore: {
        countL0: () => 7,
        countL1: async () => 5,
      },
    });

    const cp = await checkpoint.read();
    expect(cp.l0_conversations_count).toBe(7);
    expect(cp.total_memories_extracted).toBe(5);
    expect(cp.memories_since_last_persona).toBe(1);
  });
});
