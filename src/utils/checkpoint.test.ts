import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointManager } from "./checkpoint.js";
import { LocalMemoryCleaner } from "./memory-cleaner.js";

type RecalibratingCheckpointManager = CheckpointManager & {
  recalibrate(store?: {
    countL0(): number | Promise<number>;
    countL1(): number | Promise<number>;
  }): Promise<void>;
};

const tempDirs: string[] = [];

async function makeDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-checkpoint-"));
  tempDirs.push(dir);
  return dir;
}

async function writeJsonl(filePath: string, records: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    "utf-8",
  );
}

describe("CheckpointManager recalibrate", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("recounts L0 and L1 counters from JSONL fallback data", async () => {
    const dataDir = await makeDataDir();
    await writeJsonl(path.join(dataDir, "conversations", "2026-07-05.jsonl"), [
      { sessionKey: "s1", content: "hello" },
      { sessionKey: "s1", content: "world" },
      { sessionKey: "s2", content: "again" },
    ]);
    await writeJsonl(path.join(dataDir, "records", "2026-07-05.jsonl"), [
      { id: "m1", content: "memory 1" },
      { id: "m2", content: "memory 2" },
    ]);

    const manager = new CheckpointManager(dataDir) as RecalibratingCheckpointManager;
    const initial = await manager.read();
    await manager.write({
      ...initial,
      total_processed: 99,
      memories_since_last_persona: 10,
      l0_conversations_count: 50,
      total_memories_extracted: 50,
      runner_states: {
        s1: {
          last_captured_timestamp: 123,
          last_l1_cursor: 456,
          last_scene_name: "scene",
        },
      },
    });

    expect(typeof manager.recalibrate).toBe("function");
    await manager.recalibrate();

    const recalibrated = await manager.read();
    expect(recalibrated.l0_conversations_count).toBe(3);
    expect(recalibrated.total_memories_extracted).toBe(2);
    expect(recalibrated.memories_since_last_persona).toBe(2);
    expect(recalibrated.total_processed).toBe(99);
    expect(recalibrated.runner_states.s1?.last_l1_cursor).toBe(456);
  });

  it("prefers live store counts over JSONL fallback data", async () => {
    const dataDir = await makeDataDir();
    await writeJsonl(path.join(dataDir, "conversations", "2026-07-05.jsonl"), [
      { sessionKey: "s1", content: "jsonl l0" },
    ]);
    await writeJsonl(path.join(dataDir, "records", "2026-07-05.jsonl"), [
      { id: "m1", content: "jsonl l1" },
    ]);

    const manager = new CheckpointManager(dataDir) as RecalibratingCheckpointManager;
    const initial = await manager.read();
    await manager.write({
      ...initial,
      memories_since_last_persona: 4,
      l0_conversations_count: 99,
      total_memories_extracted: 99,
    });

    await manager.recalibrate({
      countL0: async () => 6,
      countL1: async () => 7,
    });

    const recalibrated = await manager.read();
    expect(recalibrated.l0_conversations_count).toBe(6);
    expect(recalibrated.total_memories_extracted).toBe(7);
    expect(recalibrated.memories_since_last_persona).toBe(4);
  });

  it("recalibrates checkpoint counters after memory cleaner removes JSONL shards", async () => {
    const dataDir = await makeDataDir();
    await writeJsonl(path.join(dataDir, "conversations", "2026-07-01.jsonl"), [
      { sessionKey: "old", content: "old l0 1" },
      { sessionKey: "old", content: "old l0 2" },
    ]);
    await writeJsonl(path.join(dataDir, "records", "2026-07-01.jsonl"), [
      { id: "old-m1", content: "old memory 1" },
      { id: "old-m2", content: "old memory 2" },
    ]);
    await writeJsonl(path.join(dataDir, "conversations", "2026-07-05.jsonl"), [
      { sessionKey: "new", content: "new l0" },
    ]);
    await writeJsonl(path.join(dataDir, "records", "2026-07-05.jsonl"), [
      { id: "new-m1", content: "new memory" },
    ]);

    const manager = new CheckpointManager(dataDir) as RecalibratingCheckpointManager;
    const initial = await manager.read();
    await manager.write({
      ...initial,
      memories_since_last_persona: 9,
      l0_conversations_count: 99,
      total_memories_extracted: 99,
    });

    const cleaner = new LocalMemoryCleaner({
      baseDir: dataDir,
      retentionDays: 2,
      cleanTime: "03:00",
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });

    await cleaner.runOnce(new Date("2026-07-05T12:00:00Z").getTime());

    const recalibrated = await manager.read();
    expect(recalibrated.l0_conversations_count).toBe(1);
    expect(recalibrated.total_memories_extracted).toBe(1);
    expect(recalibrated.memories_since_last_persona).toBe(1);
  });
});
