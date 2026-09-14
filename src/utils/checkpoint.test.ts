import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CheckpointManager } from "./checkpoint.js";
import { LocalMemoryCleaner } from "./memory-cleaner.js";
import { readConversationMessagesGroupedBySessionId } from "../core/conversation/l0-recorder.js";
import type { IMemoryStore } from "../core/store/types.js";

const tempDirs: string[] = [];

describe("CheckpointManager recalculation", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("recalculates counters after manual JSONL pruning", async () => {
    const dataDir = await makeTempDataDir();
    await writeL0Records(dataDir, [
      l0Record("session-a", "l0-1", "2026-06-29T00:00:00.000Z", 101),
      l0Record("session-a", "l0-2", "2026-06-29T00:00:01.000Z", 102),
    ]);
    await writeL1Records(dataDir, [
      l1Record("session-a", "l1-1", "2026-06-29T00:00:00.000Z"),
      l1Record("session-a", "l1-2", "2026-06-29T00:00:01.000Z"),
      l1Record("session-a", "l1-3", "2026-06-29T00:00:02.000Z"),
    ]);

    const checkpoint = new CheckpointManager(dataDir);
    await checkpoint.write({
      ...(await checkpoint.read()),
      l0_conversations_count: 9,
      total_processed: 9,
      total_memories_extracted: 8,
      memories_since_last_persona: 7,
    });

    await checkpoint.recalculate();

    const cp = await checkpoint.read();
    expect(cp.l0_conversations_count).toBe(2);
    expect(cp.total_processed).toBe(2);
    expect(cp.total_memories_extracted).toBe(3);
    expect(cp.memories_since_last_persona).toBe(2);
  });

  it("clamps stale L1 and L2 cursors to retained local data", async () => {
    const dataDir = await makeTempDataDir();
    await writeL0Records(dataDir, [
      l0Record("session-a", "l0-1", "2026-06-29T00:00:00.000Z", 101),
    ]);
    await writeL1Records(dataDir, [
      l1Record("session-a", "l1-1", "2026-06-29T00:00:01.000Z"),
    ]);

    const checkpoint = new CheckpointManager(dataDir);
    await checkpoint.write({
      ...(await checkpoint.read()),
      runner_states: {
        "session-a": {
          last_captured_timestamp: 999,
          last_l1_cursor: Date.parse("2026-06-30T00:00:00.000Z"),
          last_scene_name: "old",
        },
      },
      pipeline_states: {
        "session-a": {
          conversation_count: 0,
          last_extraction_time: "",
          last_extraction_updated_time: "2026-06-30T00:00:00.000Z",
          last_active_time: 0,
          l2_pending_l1_count: 0,
          warmup_threshold: 0,
          l2_last_extraction_time: "",
        },
      },
    });

    await checkpoint.recalculate();

    const cp = await checkpoint.read();
    expect(cp.runner_states["session-a"].last_captured_timestamp).toBe(101);
    expect(cp.runner_states["session-a"].last_l1_cursor).toBe(Date.parse("2026-06-29T00:00:00.000Z"));
    expect(cp.pipeline_states["session-a"].last_extraction_updated_time).toBe("2026-06-29T00:00:01.000Z");

    await writeL0Records(dataDir, [
      l0Record("session-a", "l0-1", "2026-06-29T00:00:00.000Z", 101),
      l0Record("session-a", "l0-new-after-cleanup", "2026-06-29T00:00:02.000Z", 103),
    ]);
    const groups = await readConversationMessagesGroupedBySessionId(
      "session-a",
      dataDir,
      cp.runner_states["session-a"].last_l1_cursor,
    );
    expect(groups.flatMap((group) => group.messages.map((message) => message.id))).toEqual(["l0-new-after-cleanup"]);
  });

  it("resets stale session cursors when a session has no retained data", async () => {
    const dataDir = await makeTempDataDir();
    await writeL0Records(dataDir, [
      l0Record("session-a", "l0-1", "2026-06-29T00:00:00.000Z", 101),
    ]);
    await writeL1Records(dataDir, [
      l1Record("session-a", "l1-1", "2026-06-29T00:00:01.000Z"),
    ]);

    const checkpoint = new CheckpointManager(dataDir);
    await checkpoint.write({
      ...(await checkpoint.read()),
      runner_states: {
        "session-a": {
          last_captured_timestamp: 101,
          last_l1_cursor: Date.parse("2026-06-29T00:00:00.000Z"),
          last_scene_name: "kept",
        },
        "session-b": {
          last_captured_timestamp: 999,
          last_l1_cursor: Date.parse("2026-06-30T00:00:00.000Z"),
          last_scene_name: "deleted",
        },
      },
      pipeline_states: {
        "session-a": {
          conversation_count: 0,
          last_extraction_time: "",
          last_extraction_updated_time: "2026-06-29T00:00:01.000Z",
          last_active_time: 0,
          l2_pending_l1_count: 0,
          warmup_threshold: 0,
          l2_last_extraction_time: "",
        },
        "session-b": {
          conversation_count: 0,
          last_extraction_time: "",
          last_extraction_updated_time: "2026-06-30T00:00:00.000Z",
          last_active_time: 0,
          l2_pending_l1_count: 0,
          warmup_threshold: 0,
          l2_last_extraction_time: "",
        },
      },
    });

    const result = await checkpoint.recalculate();

    const cp = await checkpoint.read();
    expect(cp.runner_states["session-a"].last_captured_timestamp).toBe(101);
    expect(cp.runner_states["session-a"].last_l1_cursor).toBe(Date.parse("2026-06-29T00:00:00.000Z"));
    expect(cp.pipeline_states["session-a"].last_extraction_updated_time).toBe("2026-06-29T00:00:01.000Z");
    expect(cp.runner_states["session-b"].last_captured_timestamp).toBe(0);
    expect(cp.runner_states["session-b"].last_l1_cursor).toBe(0);
    expect(cp.pipeline_states["session-b"].last_extraction_updated_time).toBe("");
    expect(result.adjustedRunnerSessions).toBe(1);
    expect(result.adjustedPipelineSessions).toBe(1);
  });

  it("uses post-cleanup store counts when provided by memory cleaner", async () => {
    const dataDir = await makeTempDataDir();
    await writeL0Records(dataDir, [
      l0Record("session-a", "old-l0", "2026-06-28T00:00:00.000Z", 101),
      l0Record("session-a", "new-l0", "2026-06-30T00:00:00.000Z", 201),
    ]);
    await writeL1Records(dataDir, [
      l1Record("session-a", "old-l1", "2026-06-28T00:00:00.000Z"),
      l1Record("session-a", "new-l1", "2026-06-30T00:00:00.000Z"),
    ]);

    const checkpoint = new CheckpointManager(dataDir);
    await checkpoint.write({
      ...(await checkpoint.read()),
      l0_conversations_count: 10,
      total_processed: 10,
      total_memories_extracted: 10,
      memories_since_last_persona: 10,
    });

    const store = new FakeMemoryStore({ l0: 1, l1: 1 });
    const cleaner = new LocalMemoryCleaner({
      baseDir: dataDir,
      retentionDays: 2,
      cleanTime: "03:00",
      vectorStore: store,
      checkpoint,
    });

    await cleaner.runOnce(Date.parse("2026-06-30T12:00:00.000Z"));

    const cp = await checkpoint.read();
    expect(cp.l0_conversations_count).toBe(1);
    expect(cp.total_processed).toBe(1);
    expect(cp.total_memories_extracted).toBe(1);
    expect(cp.memories_since_last_persona).toBe(1);

    const conversations = await readFile(path.join(dataDir, "conversations", "2026-06-30.jsonl"), "utf-8");
    expect(conversations).toContain("new-l0");
  });
});

async function makeTempDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "tdai-checkpoint-"));
  tempDirs.push(dir);
  return dir;
}

async function writeL0Records(dataDir: string, records: Array<Record<string, unknown>>): Promise<void> {
  const dir = path.join(dataDir, "conversations");
  await writeRecordsByShardDate(dir, records, "recordedAt");
}

async function writeL1Records(dataDir: string, records: Array<Record<string, unknown>>): Promise<void> {
  const dir = path.join(dataDir, "records");
  await writeRecordsByShardDate(dir, records, "updatedAt");
}

async function writeRecordsByShardDate(
  dir: string,
  records: Array<Record<string, unknown>>,
  dateField: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const byDate = new Map<string, Record<string, unknown>[]>();
  for (const record of records) {
    const value = typeof record[dateField] === "string" ? record[dateField] as string : "2026-06-29T00:00:00.000Z";
    const shard = value.slice(0, 10);
    byDate.set(shard, [...(byDate.get(shard) ?? []), record]);
  }
  for (const [shard, shardRecords] of byDate) {
    await writeFile(path.join(dir, `${shard}.jsonl`), shardRecords.map((record) => JSON.stringify(record)).join("\n") + "\n");
  }
}

function l0Record(sessionKey: string, id: string, recordedAt: string, timestamp: number): Record<string, unknown> {
  return {
    sessionKey,
    sessionId: "sid",
    recordedAt,
    id,
    role: "user",
    content: id,
    timestamp,
  };
}

function l1Record(sessionKey: string, id: string, updatedAt: string): Record<string, unknown> {
  return {
    id,
    content: id,
    type: "episodic",
    priority: 50,
    scene_name: "test",
    source_message_ids: [],
    metadata: {},
    timestamps: [updatedAt],
    createdAt: updatedAt,
    updatedAt,
    sessionKey,
    sessionId: "sid",
  };
}

class FakeMemoryStore implements Partial<IMemoryStore> {
  constructor(private readonly counts: { l0: number; l1: number }) {}

  isDegraded(): boolean {
    return false;
  }

  async countL0(): Promise<number> {
    return this.counts.l0;
  }

  async countL1(): Promise<number> {
    return this.counts.l1;
  }

  async deleteL0Expired(): Promise<number> {
    return 1;
  }

  async deleteL1Expired(): Promise<number> {
    return 1;
  }
}
