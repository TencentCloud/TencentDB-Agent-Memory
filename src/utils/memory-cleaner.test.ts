import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { IMemoryStore } from "../core/store/types.js";
import { CheckpointManager } from "./checkpoint.js";
import { LocalMemoryCleaner } from "./memory-cleaner.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-cleaner-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("LocalMemoryCleaner", () => {
  it("recalibrates from remaining JSONL shards when no vector store is available", async () => {
    const dataDir = await makeTempDir();
    const checkpoint = new CheckpointManager(dataDir);
    const conversationsDir = path.join(dataDir, "conversations");
    const recordsDir = path.join(dataDir, "records");

    await fs.mkdir(conversationsDir, { recursive: true });
    await fs.mkdir(recordsDir, { recursive: true });
    await fs.writeFile(
      path.join(conversationsDir, "2026-07-04.jsonl"),
      "{\"id\":\"old-c1\"}\n{\"id\":\"old-c2\"}\n",
    );
    await fs.writeFile(path.join(conversationsDir, "2026-07-05.jsonl"), "{\"id\":\"new-c1\"}\n");
    await fs.writeFile(
      path.join(recordsDir, "2026-07-04.jsonl"),
      "{\"id\":\"old-m1\"}\n{\"id\":\"old-m2\"}\n",
    );
    await fs.writeFile(path.join(recordsDir, "2026-07-05.jsonl"), "{\"id\":\"new-m1\"}\n");
    await checkpoint.write({
      last_captured_timestamp: 0,
      total_processed: 3,
      last_persona_at: 0,
      last_persona_time: "",
      request_persona_update: false,
      persona_update_reason: "",
      memories_since_last_persona: 3,
      scenes_processed: 0,
      runner_states: {},
      pipeline_states: {},
      l0_conversations_count: 3,
      total_memories_extracted: 3,
    });

    const cleaner = new LocalMemoryCleaner({
      baseDir: dataDir,
      retentionDays: 2,
      cleanTime: "00:00",
    });

    await cleaner.runOnce(new Date("2026-07-06T12:00:00+08:00").getTime());

    const cp = await checkpoint.read();
    expect(cp.l0_conversations_count).toBe(1);
    expect(cp.total_processed).toBe(1);
    expect(cp.total_memories_extracted).toBe(1);
    expect(cp.memories_since_last_persona).toBe(1);
    await expect(fs.stat(path.join(conversationsDir, "2026-07-04.jsonl"))).rejects.toThrow();
    await expect(fs.stat(path.join(recordsDir, "2026-07-04.jsonl"))).rejects.toThrow();
  });

  it("decrements checkpoint counters from known cleanup counts before recalibration", async () => {
    const dataDir = await makeTempDir();
    const checkpoint = new CheckpointManager(dataDir);
    await checkpoint.write({
      last_captured_timestamp: 0,
      total_processed: 60,
      last_persona_at: 0,
      last_persona_time: "",
      request_persona_update: false,
      persona_update_reason: "",
      memories_since_last_persona: 30,
      scenes_processed: 0,
      runner_states: {},
      pipeline_states: {},
      l0_conversations_count: 60,
      total_memories_extracted: 30,
    });

    let l0CountCalls = 0;
    let l1CountCalls = 0;
    let l0 = 60;
    let l1 = 30;
    const vectorStore = {
      countL0: () => {
        l0CountCalls += 1;
        if (l0CountCalls > 1) throw new Error("count unavailable");
        return l0;
      },
      countL1: () => {
        l1CountCalls += 1;
        if (l1CountCalls > 1) throw new Error("count unavailable");
        return l1;
      },
      deleteL0Expired: () => {
        l0 -= 5;
        return 5;
      },
      deleteL1Expired: () => {
        l1 -= 4;
        return 4;
      },
    } as unknown as IMemoryStore;

    const cleaner = new LocalMemoryCleaner({
      baseDir: dataDir,
      retentionDays: 2,
      cleanTime: "00:00",
      vectorStore,
    });

    await cleaner.runOnce(new Date("2026-07-06T12:00:00+08:00").getTime());

    const cp = await checkpoint.read();
    expect(cp.l0_conversations_count).toBe(55);
    expect(cp.total_processed).toBe(55);
    expect(cp.total_memories_extracted).toBe(26);
    expect(cp.memories_since_last_persona).toBe(26);
  });
});
