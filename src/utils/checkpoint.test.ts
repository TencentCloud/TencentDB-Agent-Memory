import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { recordConversation } from "../core/conversation/l0-recorder.js";
import { writeMemory } from "../core/record/l1-writer.js";
import type { IMemoryStore, L1RecordRow } from "../core/store/types.js";
import { countCheckpointJsonlData } from "./checkpoint-data.js";
import {
  createMemoryStoreMock,
  createMockLogger,
  createTempDirFixture,
  seedCheckpoint,
  writeJsonlShard,
} from "../__tests__/helpers/checkpoint-fixtures.js";
import { CheckpointManager } from "./checkpoint.js";

const tempDirs = createTempDirFixture("checkpoint-test-");
const makeTempDir = () => tempDirs.create();

afterEach(async () => {
  await tempDirs.cleanup();
});

function row(id: string): L1RecordRow {
  return {
    record_id: id,
    content: id,
    type: "fact",
    priority: 1,
    scene_name: "",
    session_key: "session",
    session_id: "",
    timestamp_str: "",
    timestamp_start: "",
    timestamp_end: "",
    created_time: "2026-01-01T00:00:00.000Z",
    updated_time: "2026-01-02T00:00:00.000Z",
    metadata_json: "{}",
  };
}

function storeWithCounts(l0: number, l1: number, sinceRows: L1RecordRow[] = []): IMemoryStore {
  return createMemoryStoreMock({
    countL0: () => l0,
    countL1: () => l1,
    queryL1Records: () => sinceRows,
  });
}

describe("CheckpointManager counter reconciliation", () => {
  it("does not rewrite the checkpoint when consecutive recalibration finds no changes", async () => {
    const dataDir = await makeTempDir();
    const logger = createMockLogger();
    const manager = await seedCheckpoint(dataDir, {
      l0_conversations_count: 9,
      total_memories_extracted: 8,
      memories_since_last_persona: 7,
    }, logger);

    const store = createMemoryStoreMock({
      readCheckpointCountsStrict: vi.fn(() => ({ l0: 3, l1: 2, l1Since: 1 })),
    });
    const writeRaw = vi.spyOn(
      manager as unknown as { writeRaw(value: unknown): Promise<void> },
      "writeRaw",
    );

    const first = await manager.recalibrateFromStorage(store, "first");
    expect(first).toEqual({
      source: "store",
      status: "reconciled",
      l0: 3,
      l1: 2,
      memoriesSincePersona: 1,
      changed: true,
    });
    expect(writeRaw).toHaveBeenCalledTimes(1);
    const checkpointPath = path.join(dataDir, ".metadata", "recall_checkpoint.json");
    const contentAfterFirst = await fs.readFile(checkpointPath, "utf-8");

    writeRaw.mockClear();
    const second = await manager.recalibrateFromStorage(store, "second");
    const contentAfterSecond = await fs.readFile(checkpointPath, "utf-8");

    expect(second).toEqual({
      source: "store",
      status: "reconciled",
      l0: 3,
      l1: 2,
      memoriesSincePersona: 1,
      changed: false,
    });
    expect(writeRaw).not.toHaveBeenCalled();
    expect(contentAfterSecond).toBe(contentAfterFirst);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("changed=false"));
  });

  it("preserves checkpoint metadata and cursors while reconciling legacy Store counts", async () => {
    const dataDir = await makeTempDir();
    const manager = new CheckpointManager(dataDir);
    const original = await manager.read();
    original.total_processed = 99;
    original.l0_conversations_count = 88;
    original.total_memories_extracted = 77;
    original.memories_since_last_persona = 66;
    original.last_captured_timestamp = 123;
    original.last_persona_at = 12;
    original.last_persona_time = "2026-01-01T00:00:00.000Z";
    original.request_persona_update = true;
    original.persona_update_reason = "manual";
    original.scenes_processed = 9;
    original.runner_states.session = {
      last_captured_timestamp: 456,
      last_l1_cursor: 789,
      last_scene_name: "scene",
    };
    original.pipeline_states.session = {
      conversation_count: 3,
      last_extraction_time: "a",
      last_extraction_updated_time: "b",
      last_active_time: 4,
      l2_pending_l1_count: 5,
      warmup_threshold: 6,
      l2_last_extraction_time: "c",
    };
    await manager.write(original);

    const result = await manager.recalibrateFromStorage(
      storeWithCounts(42, 17, [row("1"), row("2")]),
      "test",
    );
    const actual = await manager.read();

    expect(result).toEqual({
      source: "store",
      status: "reconciled",
      l0: 42,
      l1: 17,
      memoriesSincePersona: 2,
      changed: true,
    });
    expect(actual.total_processed).toBe(99);
    expect(actual.l0_conversations_count).toBe(42);
    expect(actual.total_memories_extracted).toBe(17);
    expect(actual.memories_since_last_persona).toBe(2);
    expect(actual.last_captured_timestamp).toBe(123);
    expect(actual.last_persona_at).toBe(12);
    expect(actual.last_persona_time).toBe("2026-01-01T00:00:00.000Z");
    expect(actual.request_persona_update).toBe(true);
    expect(actual.persona_update_reason).toBe("manual");
    expect(actual.scenes_processed).toBe(9);
    expect(actual.runner_states).toEqual(original.runner_states);
    expect(actual.pipeline_states).toEqual(original.pipeline_states);
  });

  it("preserves default zero counters when canonical JSONL directories do not exist", async () => {
    const dataDir = await makeTempDir();
    const logger = createMockLogger();
    const manager = new CheckpointManager(dataDir, logger);
    const result = await manager.recalibrateFromStorage(undefined, "missing-jsonl");
    expect(result).toEqual({
      source: "checkpoint",
      status: "preserved",
      l0: 0,
      l1: 0,
      memoriesSincePersona: 0,
      changed: false,
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("directories missing"));
  });

  it("preserves non-zero counters when Store and canonical JSONL directories are unavailable", async () => {
    const dataDir = await makeTempDir();
    const logger = createMockLogger();
    const manager = await seedCheckpoint(dataDir, {
      l0_conversations_count: 12,
      total_memories_extracted: 8,
      memories_since_last_persona: 3,
    }, logger);

    const result = await manager.recalibrateFromStorage(undefined, "missing-sources");

    expect(result).toEqual({
      source: "checkpoint",
      status: "preserved",
      l0: 12,
      l1: 8,
      memoriesSincePersona: 3,
      changed: false,
    });
    expect(await manager.read()).toMatchObject({
      l0_conversations_count: 12,
      total_memories_extracted: 8,
      memories_since_last_persona: 3,
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("preserving unavailable counters"));
  });

  it("preserves a missing JSONL layer while reconciling a present empty layer", async () => {
    const dataDir = await makeTempDir();
    await fs.mkdir(path.join(dataDir, "conversations"), { recursive: true });
    const manager = await seedCheckpoint(dataDir, {
      l0_conversations_count: 12,
      total_memories_extracted: 8,
      memories_since_last_persona: 3,
    });

    const result = await manager.recalibrateFromStorage(undefined, "partial-jsonl");

    expect(result).toEqual({
      source: "jsonl",
      status: "preserved",
      l0: 0,
      l1: 8,
      memoriesSincePersona: 3,
      changed: true,
    });
    expect(await manager.read()).toMatchObject({
      l0_conversations_count: 0,
      total_memories_extracted: 8,
      memories_since_last_persona: 3,
    });
  });

  it("reconciles non-zero counters to zero when canonical JSONL directories are present and empty", async () => {
    const dataDir = await tempDirs.create(true);
    const manager = await seedCheckpoint(dataDir, {
      l0_conversations_count: 12,
      total_memories_extracted: 8,
      memories_since_last_persona: 3,
    });

    const result = await manager.recalibrateFromStorage(undefined, "empty-jsonl");

    expect(result).toEqual({
      source: "jsonl",
      status: "reconciled",
      l0: 0,
      l1: 0,
      memoriesSincePersona: 0,
      changed: true,
    });
    expect(await manager.read()).toMatchObject({
      l0_conversations_count: 0,
      total_memories_extracted: 0,
      memories_since_last_persona: 0,
    });
  });

  it("surfaces canonical JSONL directory read failures instead of treating them as empty", async () => {
    const dataDir = await makeTempDir();
    await fs.writeFile(path.join(dataDir, "conversations"), "not a directory", "utf-8");
    await fs.mkdir(path.join(dataDir, "records"), { recursive: true });

    await expect(countCheckpointJsonlData(dataDir)).rejects.toMatchObject({
      code: "ENOTDIR",
    });
  });

  it("counts canonical JSONL emitted by the L0 and L1 writers", async () => {
    const dataDir = await makeTempDir();
    const beforeWrite = new Date(Date.now() - 60_000).toISOString();
    const captured = await recordConversation({
      sessionKey: "writer-session",
      sessionId: "writer-conversation",
      baseDir: dataDir,
      rawMessages: [
        { id: "writer-l0-user", role: "user", content: "Remember this canonical user message.", timestamp: 100 },
        { id: "writer-l0-assistant", role: "assistant", content: "Canonical assistant response.", timestamp: 200 },
      ],
    });
    const memory = await writeMemory({
      baseDir: dataDir,
      sessionKey: "writer-session",
      sessionId: "writer-conversation",
      memory: {
        content: "The user asked to remember a canonical writer record.",
        type: "persona",
        priority: 80,
        scene_name: "writer-test",
        source_message_ids: ["writer-l0-user"],
        metadata: {},
      },
      decision: {
        record_id: "writer-l1",
        action: "store",
        target_ids: [],
      },
    });

    expect(captured).toHaveLength(2);
    expect(memory).toMatchObject({
      id: "writer-l1",
      sessionKey: "writer-session",
      sessionId: "writer-conversation",
    });
    await expect(countCheckpointJsonlData(dataDir, undefined, beforeWrite)).resolves.toEqual({
      l0: 2,
      l1: 1,
      l1Since: 1,
      directories: { l0: "present", l1: "present" },
    });
  });

  it("falls back to JSONL when Store is degraded", async () => {
    const dataDir = await makeTempDir();
    await writeJsonlShard(dataDir, "conversations", "2026-01-02.jsonl", [
      { sessionKey: "s", role: "user", content: "one", timestamp: 1 },
      { sessionKey: "s", role: "assistant", content: "two", timestamp: 2 },
    ]);
    await writeJsonlShard(dataDir, "records", "2026-01-02.jsonl", [
      { id: "m1", sessionKey: "s", createdAt: "2026-01-02T00:00:00.000Z" },
      { id: "m2", sessionKey: "s", updatedAt: "2026-01-02T01:00:00.000Z" },
    ]);

    const countL0 = vi.fn(() => 99);
    const countL1 = vi.fn(() => 88);
    const degradedStore = createMemoryStoreMock({
      isDegraded: () => true,
      countL0,
      countL1,
    });
    const manager = new CheckpointManager(dataDir);

    const result = await manager.recalibrateFromStorage(degradedStore, "degraded-test");

    expect(result.source).toBe("jsonl");
    expect(result).toEqual({
      source: "jsonl",
      status: "reconciled",
      l0: 2,
      l1: 2,
      memoriesSincePersona: 2,
      changed: true,
    });
    expect(countL0).not.toHaveBeenCalled();
    expect(countL1).not.toHaveBeenCalled();
  });

  it("uses JSONL counts and preserves history when Store reads fail", async () => {
    const dataDir = await makeTempDir();
    await writeJsonlShard(dataDir, "conversations", "2026-01-03.jsonl", [
      { sessionKey: "s", role: "user", content: "one", timestamp: 1 },
      { sessionKey: "s", role: "assistant", content: "two", timestamp: 2 },
      { sessionKey: "s", role: "user", content: "three", timestamp: 3 },
    ]);
    await writeJsonlShard(dataDir, "records", "2026-01-03.jsonl", [
      { id: "m1", sessionKey: "s", createdAt: "2026-01-03T00:00:00.000Z" },
      { id: "m2", sessionKey: "s", updatedAt: "2026-01-03T01:00:00.000Z" },
    ]);

    const logger = createMockLogger();
    const manager = new CheckpointManager(dataDir, logger);
    const oldCheckpoint = await manager.read();
    oldCheckpoint.total_processed = 300;
    oldCheckpoint.l0_conversations_count = 200;
    oldCheckpoint.total_memories_extracted = 100;
    oldCheckpoint.memories_since_last_persona = 90;
    oldCheckpoint.last_captured_timestamp = 1234;
    oldCheckpoint.runner_states.s = {
      last_captured_timestamp: 1200,
      last_l1_cursor: 1100,
      last_scene_name: "preserved-scene",
    };
    oldCheckpoint.pipeline_states.s = {
      conversation_count: 4,
      last_extraction_time: "2026-01-02T00:00:00.000Z",
      last_extraction_updated_time: "2026-01-02T01:00:00.000Z",
      last_active_time: 1000,
      l2_pending_l1_count: 2,
      warmup_threshold: 4,
      l2_last_extraction_time: "2026-01-02T02:00:00.000Z",
    };
    const expectedRunnerStates = structuredClone(oldCheckpoint.runner_states);
    const expectedPipelineStates = structuredClone(oldCheckpoint.pipeline_states);
    await manager.write(oldCheckpoint);

    const store = createMemoryStoreMock({
      isDegraded: vi.fn(() => false),
      countL0: vi.fn(() => { throw new Error("store read failed"); }),
      countL1: vi.fn(() => 999),
      queryL1Records: vi.fn(() => []),
    });

    const result = await manager.recalibrateFromStorage(store, "store-failure-test");
    const actual = await manager.read();

    expect(result.source).toBe("jsonl");
    expect(result.l0).toBe(3);
    expect(result.l1).toBe(2);
    expect(actual.total_processed).toBe(300);
    expect(actual.l0_conversations_count).toBe(3);
    expect(actual.total_memories_extracted).toBe(2);
    expect(actual.memories_since_last_persona).toBe(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Store recalibration failed"));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("falling back to JSONL"));
    expect(actual.last_captured_timestamp).toBe(1234);
    expect(actual.runner_states).toEqual(expectedRunnerStates);
    expect(actual.pipeline_states).toEqual(expectedPipelineStates);
  });

  it("counts valid date shards, legacy L0 messages, and L1 records after persona time", async () => {
    const dataDir = await tempDirs.create(true);
    const validMessage = { role: "user", content: "hello", timestamp: 1 };
    await fs.writeFile(path.join(dataDir, "conversations", "2026-01-02.jsonl"), [
      JSON.stringify({ sessionKey: "s", ...validMessage }),
      "{broken",
      JSON.stringify({ sessionKey: "s", role: "system", content: "ignored", timestamp: 2 }),
      JSON.stringify({ sessionKey: "s", messages: [validMessage, { role: "user" }] }),
      "",
    ].join("\n"));
    await fs.writeFile(
      path.join(dataDir, "conversations", "notes.jsonl"),
      JSON.stringify({ sessionKey: "s", ...validMessage }) + "\n",
    );
    await fs.writeFile(path.join(dataDir, "records", "2026-01-02.json"), [
      JSON.stringify({ id: "old", sessionKey: "s", createdAt: "2025-12-31T00:00:00.000Z" }),
      JSON.stringify({ id: "new", sessionKey: "s", updated_time: "2026-01-02T00:00:00.000Z" }),
      JSON.stringify({ id: "missing-time", sessionKey: "s" }),
      "not-json",
    ].join("\n"));

    const logger = createMockLogger();
    const manager = new CheckpointManager(dataDir, logger);
    const cp = await manager.read();
    cp.last_persona_time = "2026-01-01T00:00:00.000Z";
    cp.runner_states.s = { last_captured_timestamp: 8, last_l1_cursor: 9, last_scene_name: "x" };
    await manager.write(cp);

    const result = await manager.recalibrateFromStorage(undefined, "jsonl-test");
    expect(result).toEqual({
      source: "jsonl",
      status: "reconciled",
      l0: 2,
      l1: 2,
      memoriesSincePersona: 1,
      changed: true,
    });
    expect(logger.warn).toHaveBeenCalled();
    expect((await manager.read()).runner_states.s.last_l1_cursor).toBe(9);
  });

  it("preserves historical total_processed while cleanup updates current counters", async () => {
    const dataDir = await makeTempDir();
    const manager = await seedCheckpoint(dataDir, {
      total_processed: 500,
      l0_conversations_count: 100,
      total_memories_extracted: 50,
      memories_since_last_persona: 10,
    });

    const readCheckpointCountsStrict = vi.fn()
      .mockResolvedValueOnce({ l0: 96, l1: 52, l1Since: 15 })
      .mockResolvedValueOnce({ l0: 96, l1: 0, l1Since: 0 });
    const store = createMemoryStoreMock({
      readCheckpointCountsStrict,
    });

    await Promise.all([
      manager.markL1ExtractionComplete("s", 5, 123, "scene"),
      manager.applyCleanupDelta({ removedL0: 4.8, removedL1: 3.8, reason: "concurrent" }, store),
    ]);
    let actual = await manager.read();
    expect(actual.total_processed).toBe(500);
    expect(actual.l0_conversations_count).toBe(96);
    expect(actual.total_memories_extracted).toBe(52);
    expect(actual.memories_since_last_persona).toBe(15);
    expect(actual.runner_states.s.last_l1_cursor).toBe(123);

    await manager.applyCleanupDelta(
      { removedL0: Number.POSITIVE_INFINITY, removedL1: 99, reason: "clamp" },
      store,
    );
    actual = await manager.read();
    expect(actual.total_processed).toBe(500);
    expect(actual.l0_conversations_count).toBe(96);
    expect(actual.total_memories_extracted).toBe(0);
    expect(actual.memories_since_last_persona).toBe(0);
  });

  it("keeps persona count for old Store deletions and reduces it for recent deletions", async () => {
    const dataDir = await makeTempDir();
    const manager = await seedCheckpoint(dataDir, {
      total_memories_extracted: 50,
      memories_since_last_persona: 10,
      last_persona_time: "2026-01-15T00:00:00.000Z",
    });

    const readCheckpointCountsStrict = vi.fn()
      .mockResolvedValueOnce({ l0: 0, l1: 45, l1Since: 10 })
      .mockResolvedValueOnce({ l0: 0, l1: 40, l1Since: 5 });
    const store = createMemoryStoreMock({
      readCheckpointCountsStrict,
    });

    await manager.applyCleanupDelta({ removedL0: 0, removedL1: 5, reason: "old-l1" }, store);
    let actual = await manager.read();
    expect(actual.total_memories_extracted).toBe(45);
    expect(actual.memories_since_last_persona).toBe(10);

    await manager.applyCleanupDelta({ removedL0: 0, removedL1: 5, reason: "recent-l1" }, store);
    actual = await manager.read();
    expect(actual.total_memories_extracted).toBe(40);
    expect(actual.memories_since_last_persona).toBe(5);
    expect(readCheckpointCountsStrict).toHaveBeenCalledTimes(2);
    expect(readCheckpointCountsStrict).toHaveBeenCalledWith("2026-01-15T00:00:00.000Z");
  });

  it("keeps persona count for old JSONL deletions and reduces it for recent deletions", async () => {
    const dataDir = await makeTempDir();
    const oldRecords = Array.from({ length: 35 }, (_, index) => ({
      id: `old-${index}`,
      sessionKey: "s",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));
    const recentRecords = Array.from({ length: 10 }, (_, index) => ({
      id: `recent-${index}`,
      sessionKey: "s",
      updatedAt: "2026-01-20T00:00:00.000Z",
    }));
    await writeJsonlShard(dataDir, "records", "2026-01-20.jsonl", [
      ...oldRecords,
      ...recentRecords,
    ]);
    const manager = await seedCheckpoint(dataDir, {
      total_memories_extracted: 50,
      memories_since_last_persona: 10,
      last_persona_time: "2026-01-15T00:00:00.000Z",
    });

    await manager.applyCleanupDelta({ removedL0: 0, removedL1: 5, reason: "old-jsonl-l1" });
    let actual = await manager.read();
    expect(actual.total_memories_extracted).toBe(45);
    expect(actual.memories_since_last_persona).toBe(10);

    await writeJsonlShard(dataDir, "records", "2026-01-20.jsonl", [
      ...oldRecords,
      ...recentRecords.slice(0, 5),
    ]);
    await manager.applyCleanupDelta({ removedL0: 0, removedL1: 5, reason: "recent-jsonl-l1" });
    actual = await manager.read();
    expect(actual.total_memories_extracted).toBe(40);
    expect(actual.memories_since_last_persona).toBe(5);
  });

  it("preserves persona count when cleanup cannot recount storage", async () => {
    const dataDir = await makeTempDir();
    const logger = createMockLogger();
    const manager = await seedCheckpoint(dataDir, {
      total_memories_extracted: 50,
      memories_since_last_persona: 10,
      last_persona_time: "2026-01-15T00:00:00.000Z",
    }, logger);
    const store = createMemoryStoreMock({
      readCheckpointCountsStrict: vi.fn(() => { throw new Error("strict read failed"); }),
    });

    await expect(manager.applyCleanupDelta(
      { removedL0: 0, removedL1: 5, reason: "failed-recount" },
      store,
    )).resolves.toBeUndefined();

    const actual = await manager.read();
    expect(actual.total_memories_extracted).toBe(45);
    expect(actual.memories_since_last_persona).toBe(10);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("recount failed (non-fatal)"));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("preserving previous value"));
  });

  it("increments the L0 conversation count once per successful capture", async () => {
    const dataDir = await makeTempDir();
    const manager = new CheckpointManager(dataDir);
    await manager.captureAtomically("s", undefined, async () => ({ maxTimestamp: 10, messageCount: 3 }));
    const cp = await manager.read();
    expect(cp.total_processed).toBe(3);
    expect(cp.l0_conversations_count).toBe(1);
  });
});
