import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { initTimeModule, _resetTimeModuleForTest } from "./time.js";
import { CheckpointManager, type Checkpoint } from "./checkpoint.js";
import { LocalMemoryCleaner } from "./memory-cleaner.js";
import { readConversationMessagesGroupedBySessionId } from "../core/conversation/l0-recorder.js";
import { readMemoryRecords } from "../core/record/l1-reader.js";

function makeLogger() {
  const logs = { info: [] as string[], warn: [] as string[], debug: [] as string[], error: [] as string[] };
  return {
    logs,
    logger: {
      info: (msg: string) => logs.info.push(msg),
      warn: (msg: string) => logs.warn.push(msg),
      debug: (msg: string) => logs.debug.push(msg),
      error: (msg: string) => logs.error.push(msg),
    },
  };
}

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-test-"));
}

async function writeJsonl(filePath: string, lines: Array<Record<string, unknown>>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const raw = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  await fs.writeFile(filePath, raw, "utf-8");
}

async function writeCheckpoint(manager: CheckpointManager, checkpoint: Checkpoint): Promise<void> {
  await manager.write(checkpoint);
}

async function readL1RecordsAfter(sessionKey: string, baseDir: string, cursor: string) {
  const records = await readMemoryRecords(sessionKey, baseDir);
  return records.filter((record) => {
    const t = record.updatedAt || record.createdAt || "";
    return t > cursor;
  });
}

afterEach(() => {
  _resetTimeModuleForTest();
});

describe("CheckpointManager reconciliation", () => {
  it("repairs counters and cursors after manual JSONL trimming", async () => {
    initTimeModule({ timezone: "UTC" });

    const baseDir = await createTempDir();
    const { logger } = makeLogger();
    const manager = new CheckpointManager(baseDir, logger);

    try {
      await writeJsonl(path.join(baseDir, "conversations", "2026-07-17.jsonl"), [
        {
          sessionKey: "session-a",
          sessionId: "session-a-1",
          recordedAt: "2026-07-14T10:00:00.000Z",
          id: "l0-1",
          role: "user",
          content: "hello",
          timestamp: 1000,
        },
        {
          sessionKey: "session-a",
          sessionId: "session-a-1",
          recordedAt: "2026-07-15T10:00:00.000Z",
          id: "l0-2",
          role: "assistant",
          content: "world",
          timestamp: 2000,
        },
      ]);
      await writeJsonl(path.join(baseDir, "records", "2026-07-17.jsonl"), [
        {
          sessionKey: "session-a",
          sessionId: "session-a-1",
          id: "m-1",
          content: "memory one",
          type: "episodic",
          priority: 50,
          scene_name: "scene-a",
          source_message_ids: ["l0-1"],
          metadata: {},
          timestamps: ["2026-07-14T11:00:00.000Z"],
          createdAt: "2026-07-14T11:00:00.000Z",
          updatedAt: "2026-07-14T11:00:00.000Z",
        },
        {
          sessionKey: "session-a",
          sessionId: "session-a-1",
          id: "m-2",
          content: "memory two",
          type: "episodic",
          priority: 50,
          scene_name: "scene-a",
          source_message_ids: ["l0-2"],
          metadata: {},
          timestamps: ["2026-07-15T11:00:00.000Z"],
          createdAt: "2026-07-15T11:00:00.000Z",
          updatedAt: "2026-07-15T11:00:00.000Z",
        },
      ]);

      const inflated: Checkpoint = {
        last_captured_timestamp: 9_999_999_999_999,
        total_processed: 999,
        last_persona_at: 999,
        last_persona_time: "2026-07-14T12:00:00.000Z",
        request_persona_update: false,
        persona_update_reason: "",
        memories_since_last_persona: 999,
        scenes_processed: 999,
        runner_states: {
          "session-a": {
            last_captured_timestamp: 9_999_999_999_999,
            last_l1_cursor: 9_999_999_999_999,
            last_scene_name: "scene-a",
          },
        },
        pipeline_states: {
          "session-a": {
            conversation_count: 9,
            last_extraction_time: "2026-07-15T11:00:00.000Z",
            last_extraction_updated_time: "2026-07-15T11:00:00.000Z",
            last_active_time: 1,
            l2_pending_l1_count: 0,
            warmup_threshold: 0,
            l2_last_extraction_time: "2026-07-15T11:00:00.000Z",
          },
        },
        l0_conversations_count: 999,
        total_memories_extracted: 999,
      };
      await writeCheckpoint(manager, inflated);

      await writeJsonl(path.join(baseDir, "conversations", "2026-07-17.jsonl"), [
        {
          sessionKey: "session-a",
          sessionId: "session-a-1",
          recordedAt: "2026-07-14T10:00:00.000Z",
          id: "l0-1",
          role: "user",
          content: "hello",
          timestamp: 1000,
        },
      ]);
      await writeJsonl(path.join(baseDir, "records", "2026-07-17.jsonl"), [
        {
          sessionKey: "session-a",
          sessionId: "session-a-1",
          id: "m-1",
          content: "memory one",
          type: "episodic",
          priority: 50,
          scene_name: "scene-a",
          source_message_ids: ["l0-1"],
          metadata: {},
          timestamps: ["2026-07-14T11:00:00.000Z"],
          createdAt: "2026-07-14T11:00:00.000Z",
          updatedAt: "2026-07-14T11:00:00.000Z",
        },
      ]);

      const result = await manager.recalculateFromStorage({ repairCursors: true });
      const checkpoint = await manager.read();

      expect(result.after.total_processed).toBe(1);
      expect(result.after.l0_conversations_count).toBe(1);
      expect(result.after.total_memories_extracted).toBe(1);
      expect(result.after.memories_since_last_persona).toBe(0);
      expect(result.after.scenes_processed).toBe(0);
      expect(result.repairedCursors).toBeGreaterThanOrEqual(3);

      expect(checkpoint.total_processed).toBe(1);
      expect(checkpoint.l0_conversations_count).toBe(1);
      expect(checkpoint.total_memories_extracted).toBe(1);
      expect(checkpoint.memories_since_last_persona).toBe(0);
      expect(checkpoint.last_persona_at).toBe(1);
      expect(checkpoint.last_captured_timestamp).toBe(1000);
      expect(checkpoint.runner_states["session-a"].last_captured_timestamp).toBe(1000);
      expect(checkpoint.runner_states["session-a"].last_l1_cursor).toBe(new Date("2026-07-14T10:00:00.000Z").getTime());
      expect(checkpoint.pipeline_states["session-a"].last_extraction_updated_time).toBe("2026-07-14T11:00:00.000Z");
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  it("reconciles checkpoint after memory-cleaner deletes expired shards", async () => {
    initTimeModule({ timezone: "UTC" });

    const baseDir = await createTempDir();
    const { logger } = makeLogger();
    const cleaner = new LocalMemoryCleaner({
      baseDir,
      retentionDays: 2,
      cleanTime: "03:00",
      logger,
    });
    const manager = new CheckpointManager(baseDir, logger);

    try {
      await writeJsonl(path.join(baseDir, "conversations", "2026-07-14.jsonl"), [
        {
          sessionKey: "session-b",
          sessionId: "session-b-1",
          recordedAt: "2026-07-14T10:00:00.000Z",
          id: "l0-old",
          role: "user",
          content: "old",
          timestamp: 1000,
        },
      ]);
      await writeJsonl(path.join(baseDir, "conversations", "2026-07-17.jsonl"), [
        {
          sessionKey: "session-b",
          sessionId: "session-b-1",
          recordedAt: "2026-07-17T10:00:00.000Z",
          id: "l0-new",
          role: "assistant",
          content: "new",
          timestamp: 2000,
        },
      ]);
      await writeJsonl(path.join(baseDir, "records", "2026-07-14.jsonl"), [
        {
          sessionKey: "session-b",
          sessionId: "session-b-1",
          id: "m-old",
          content: "memory old",
          type: "episodic",
          priority: 40,
          scene_name: "scene-b",
          source_message_ids: ["l0-old"],
          metadata: {},
          timestamps: ["2026-07-14T11:00:00.000Z"],
          createdAt: "2026-07-14T11:00:00.000Z",
          updatedAt: "2026-07-14T11:00:00.000Z",
        },
      ]);
      await writeJsonl(path.join(baseDir, "records", "2026-07-17.jsonl"), [
        {
          sessionKey: "session-b",
          sessionId: "session-b-1",
          id: "m-new",
          content: "memory new",
          type: "episodic",
          priority: 40,
          scene_name: "scene-b",
          source_message_ids: ["l0-new"],
          metadata: {},
          timestamps: ["2026-07-17T11:00:00.000Z"],
          createdAt: "2026-07-17T11:00:00.000Z",
          updatedAt: "2026-07-17T11:00:00.000Z",
        },
      ]);

      await writeCheckpoint(manager, {
        last_captured_timestamp: 9_999_999_999_999,
        total_processed: 500,
        last_persona_at: 400,
        last_persona_time: "2026-07-14T12:00:00.000Z",
        request_persona_update: false,
        persona_update_reason: "",
        memories_since_last_persona: 400,
        scenes_processed: 20,
        runner_states: {
          "session-b": {
            last_captured_timestamp: 9_999_999_999_999,
            last_l1_cursor: 9_999_999_999_999,
            last_scene_name: "",
          },
        },
        pipeline_states: {
          "session-b": {
            conversation_count: 8,
            last_extraction_time: "2026-07-17T11:00:00.000Z",
            last_extraction_updated_time: "2026-07-17T11:00:00.000Z",
            last_active_time: 1,
            l2_pending_l1_count: 0,
            warmup_threshold: 0,
            l2_last_extraction_time: "2026-07-17T11:00:00.000Z",
          },
        },
        l0_conversations_count: 500,
        total_memories_extracted: 400,
      });

      await cleaner.runOnce(new Date("2026-07-17T12:00:00.000Z").getTime());
      const checkpoint = await manager.read();

      await expect(fs.access(path.join(baseDir, "conversations", "2026-07-14.jsonl"))).rejects.toBeDefined();
      await expect(fs.access(path.join(baseDir, "records", "2026-07-14.jsonl"))).rejects.toBeDefined();

      expect(checkpoint.total_processed).toBe(1);
      expect(checkpoint.l0_conversations_count).toBe(1);
      expect(checkpoint.total_memories_extracted).toBe(1);
      expect(checkpoint.memories_since_last_persona).toBe(1);
      expect(checkpoint.runner_states["session-b"].last_captured_timestamp).toBe(2000);
      expect(checkpoint.runner_states["session-b"].last_l1_cursor).toBe(new Date("2026-07-17T10:00:00.000Z").getTime());
      expect(checkpoint.pipeline_states["session-b"].last_extraction_updated_time).toBe("2026-07-17T11:00:00.000Z");
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  it("makes backfilled records visible to real incremental readers after stale cursor repair", async () => {
    initTimeModule({ timezone: "UTC" });

    const baseDir = await createTempDir();
    const { logger } = makeLogger();
    const manager = new CheckpointManager(baseDir, logger);
    const sessionKey = "session-c";
    const staleL1Cursor = new Date("2026-07-15T00:00:00.000Z").getTime();
    const staleL2Cursor = "2026-07-15T00:00:00.000Z";

    try {
      await writeJsonl(path.join(baseDir, "conversations", "2026-07-10.jsonl"), [
        {
          sessionKey,
          sessionId: "session-c-1",
          recordedAt: "2026-07-10T10:00:00.000Z",
          id: "l0-baseline",
          role: "user",
          content: "baseline l0",
          timestamp: 1000,
        },
      ]);
      await writeJsonl(path.join(baseDir, "records", "2026-07-10.jsonl"), [
        {
          sessionKey,
          sessionId: "session-c-1",
          id: "m-baseline",
          content: "baseline memory",
          type: "episodic",
          priority: 40,
          scene_name: "scene-c",
          source_message_ids: ["l0-baseline"],
          metadata: {},
          timestamps: ["2026-07-10T11:00:00.000Z"],
          createdAt: "2026-07-10T11:00:00.000Z",
          updatedAt: "2026-07-10T11:00:00.000Z",
        },
      ]);

      await writeCheckpoint(manager, {
        last_captured_timestamp: 9_999_999_999_999,
        total_processed: 1,
        last_persona_at: 0,
        last_persona_time: "",
        request_persona_update: false,
        persona_update_reason: "",
        memories_since_last_persona: 1,
        scenes_processed: 0,
        runner_states: {
          [sessionKey]: {
            last_captured_timestamp: 9_999_999_999_999,
            last_l1_cursor: staleL1Cursor,
            last_scene_name: "",
          },
        },
        pipeline_states: {
          [sessionKey]: {
            conversation_count: 0,
            last_extraction_time: "",
            last_extraction_updated_time: staleL2Cursor,
            last_active_time: 1,
            l2_pending_l1_count: 0,
            warmup_threshold: 0,
            l2_last_extraction_time: "",
          },
        },
        l0_conversations_count: 1,
        total_memories_extracted: 1,
      });

      const repair = await manager.repairStaleCursorsFromStorage();
      const repaired = await manager.read();
      const repairedL1Cursor = repaired.runner_states[sessionKey].last_l1_cursor;
      const repairedL2Cursor = repaired.pipeline_states[sessionKey].last_extraction_updated_time;

      expect(repair.repairedCursors).toBe(4);
      expect(repairedL1Cursor).toBe(new Date("2026-07-10T10:00:00.000Z").getTime());
      expect(repairedL2Cursor).toBe("2026-07-10T11:00:00.000Z");

      await writeJsonl(path.join(baseDir, "conversations", "2026-07-12.jsonl"), [
        {
          sessionKey,
          sessionId: "session-c-1",
          recordedAt: "2026-07-12T10:00:00.000Z",
          id: "l0-backfilled",
          role: "assistant",
          content: "backfilled l0",
          timestamp: 2000,
        },
      ]);
      await writeJsonl(path.join(baseDir, "records", "2026-07-12.jsonl"), [
        {
          sessionKey,
          sessionId: "session-c-1",
          id: "m-backfilled",
          content: "backfilled memory",
          type: "episodic",
          priority: 40,
          scene_name: "scene-c",
          source_message_ids: ["l0-backfilled"],
          metadata: {},
          timestamps: ["2026-07-12T11:00:00.000Z"],
          createdAt: "2026-07-12T11:00:00.000Z",
          updatedAt: "2026-07-12T11:00:00.000Z",
        },
      ]);

      const l0SkippedByStale = await readConversationMessagesGroupedBySessionId(
        sessionKey,
        baseDir,
        staleL1Cursor,
      );
      const l1SkippedByStale = await readL1RecordsAfter(sessionKey, baseDir, staleL2Cursor);
      expect(l0SkippedByStale).toHaveLength(0);
      expect(l1SkippedByStale).toHaveLength(0);

      const l0VisibleAfterRepair = await readConversationMessagesGroupedBySessionId(
        sessionKey,
        baseDir,
        repairedL1Cursor,
      );
      const l1VisibleAfterRepair = await readL1RecordsAfter(sessionKey, baseDir, repairedL2Cursor);
      expect(l0VisibleAfterRepair).toHaveLength(1);
      expect(l0VisibleAfterRepair[0].messages.map((message) => message.id)).toEqual(["l0-backfilled"]);
      expect(l1VisibleAfterRepair.map((record) => record.id)).toEqual(["m-backfilled"]);
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });
});
