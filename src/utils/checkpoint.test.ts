import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { IMemoryStore, L1RecordRow } from "../core/store/types.js";
import { CheckpointManager } from "./checkpoint.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
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
  return {
    isDegraded: () => false,
    countL0: () => l0,
    countL1: () => l1,
    queryL1Records: () => sinceRows,
  } as unknown as IMemoryStore;
}

describe("CheckpointManager counter reconciliation", () => {
  it("uses healthy Store counts and preserves all cursors and persona metadata", async () => {
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

    expect(result).toEqual({ source: "store", l0: 42, l1: 17, memoriesSincePersona: 2 });
    expect(actual.total_processed).toBe(42);
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

  it("falls back to zero when JSONL directories do not exist", async () => {
    const dataDir = await makeTempDir();
    const manager = new CheckpointManager(dataDir);
    const result = await manager.recalibrateFromStorage(undefined, "missing-jsonl");
    expect(result).toEqual({ source: "jsonl", l0: 0, l1: 0, memoriesSincePersona: 0 });
  });

  it("falls back to JSONL when Store is degraded", async () => {
    const dataDir = await makeTempDir();
    await fs.mkdir(path.join(dataDir, "conversations"), { recursive: true });
    await fs.mkdir(path.join(dataDir, "records"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "conversations", "2026-01-02.jsonl"), [
      JSON.stringify({ sessionKey: "s", role: "user", content: "one", timestamp: 1 }),
      JSON.stringify({ sessionKey: "s", role: "assistant", content: "two", timestamp: 2 }),
      "",
    ].join("\n"));
    await fs.writeFile(path.join(dataDir, "records", "2026-01-02.jsonl"), [
      JSON.stringify({ id: "m1", sessionKey: "s", createdAt: "2026-01-02T00:00:00.000Z" }),
      JSON.stringify({ id: "m2", sessionKey: "s", updatedAt: "2026-01-02T01:00:00.000Z" }),
      "",
    ].join("\n"));

    const countL0 = vi.fn(() => 99);
    const countL1 = vi.fn(() => 88);
    const degradedStore = {
      isDegraded: () => true,
      countL0,
      countL1,
    } as unknown as IMemoryStore;
    const manager = new CheckpointManager(dataDir);

    const result = await manager.recalibrateFromStorage(degradedStore, "degraded-test");

    expect(result.source).toBe("jsonl");
    expect(result).toEqual({ source: "jsonl", l0: 2, l1: 2, memoriesSincePersona: 2 });
    expect(countL0).not.toHaveBeenCalled();
    expect(countL1).not.toHaveBeenCalled();
  });

  it("falls back to JSONL when a healthy Store read fails", async () => {
    const dataDir = await makeTempDir();
    await fs.mkdir(path.join(dataDir, "conversations"), { recursive: true });
    await fs.mkdir(path.join(dataDir, "records"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "conversations", "2026-01-03.jsonl"), [
      JSON.stringify({ sessionKey: "s", role: "user", content: "one", timestamp: 1 }),
      JSON.stringify({ sessionKey: "s", role: "assistant", content: "two", timestamp: 2 }),
      JSON.stringify({ sessionKey: "s", role: "user", content: "three", timestamp: 3 }),
      "",
    ].join("\n"));
    await fs.writeFile(path.join(dataDir, "records", "2026-01-03.jsonl"), [
      JSON.stringify({ id: "m1", sessionKey: "s", createdAt: "2026-01-03T00:00:00.000Z" }),
      JSON.stringify({ id: "m2", sessionKey: "s", updatedAt: "2026-01-03T01:00:00.000Z" }),
      "",
    ].join("\n"));

    const logger = { info: vi.fn(), warn: vi.fn() };
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

    const store = {
      isDegraded: vi.fn(() => false),
      countL0: vi.fn(() => { throw new Error("store read failed"); }),
      countL1: vi.fn(() => 999),
      queryL1Records: vi.fn(() => []),
    } as unknown as IMemoryStore;

    const result = await manager.recalibrateFromStorage(store, "store-failure-test");
    const actual = await manager.read();

    expect(result.source).toBe("jsonl");
    expect(result.l0).toBe(3);
    expect(result.l1).toBe(2);
    expect(actual.total_processed).toBe(3);
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
    const dataDir = await makeTempDir();
    await fs.mkdir(path.join(dataDir, "conversations"), { recursive: true });
    await fs.mkdir(path.join(dataDir, "records"), { recursive: true });
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

    const logger = { info: vi.fn(), warn: vi.fn() };
    const manager = new CheckpointManager(dataDir, logger);
    const cp = await manager.read();
    cp.last_persona_time = "2026-01-01T00:00:00.000Z";
    cp.runner_states.s = { last_captured_timestamp: 8, last_l1_cursor: 9, last_scene_name: "x" };
    await manager.write(cp);

    const result = await manager.recalibrateFromStorage(undefined, "jsonl-test");
    expect(result).toEqual({ source: "jsonl", l0: 2, l1: 2, memoriesSincePersona: 1 });
    expect(logger.warn).toHaveBeenCalled();
    expect((await manager.read()).runner_states.s.last_l1_cursor).toBe(9);
  });

  it("normalizes cleanup deltas, clamps at zero, and serializes concurrent additions", async () => {
    const dataDir = await makeTempDir();
    const manager = new CheckpointManager(dataDir);
    const cp = await manager.read();
    cp.total_processed = 10;
    cp.l0_conversations_count = 10;
    cp.total_memories_extracted = 10;
    cp.memories_since_last_persona = 10;
    await manager.write(cp);

    await Promise.all([
      manager.markL1ExtractionComplete("s", 5, 123, "scene"),
      manager.applyCleanupDelta({ removedL0: -4, removedL1: 3.8, reason: "concurrent" }),
    ]);
    let actual = await manager.read();
    expect(actual.total_processed).toBe(10);
    expect(actual.l0_conversations_count).toBe(10);
    expect(actual.total_memories_extracted).toBe(12);
    expect(actual.memories_since_last_persona).toBe(12);
    expect(actual.runner_states.s.last_l1_cursor).toBe(123);

    await manager.applyCleanupDelta({ removedL0: Number.POSITIVE_INFINITY, removedL1: 99, reason: "clamp" });
    actual = await manager.read();
    expect(actual.total_memories_extracted).toBe(0);
    expect(actual.memories_since_last_persona).toBe(0);
  });

  it("counts captured L0 messages rather than capture calls", async () => {
    const dataDir = await makeTempDir();
    const manager = new CheckpointManager(dataDir);
    await manager.captureAtomically("s", undefined, async () => ({ maxTimestamp: 10, messageCount: 3 }));
    const cp = await manager.read();
    expect(cp.total_processed).toBe(3);
    expect(cp.l0_conversations_count).toBe(3);
  });
});
