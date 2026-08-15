import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CheckpointManager,
  type CheckpointCountStore,
} from "./checkpoint.js";

async function seedCheckpoint(dataDir: string, overrides: Record<string, unknown>): Promise<void> {
  await new CheckpointManager(dataDir).write({
    last_captured_timestamp: 0,
    total_processed: 100,
    last_persona_at: 0,
    last_persona_time: "2026-07-10T00:00:00.000Z",
    request_persona_update: false,
    persona_update_reason: "",
    memories_since_last_persona: 10,
    scenes_processed: 3,
    runner_states: {
      s1: { last_captured_timestamp: 1, last_l1_cursor: 2, last_scene_name: "scene" },
    },
    pipeline_states: {
      s1: {
        conversation_count: 5,
        last_extraction_time: "time",
        last_extraction_updated_time: "time",
        last_active_time: 3,
        l2_pending_l1_count: 2,
        warmup_threshold: 4,
        l2_last_extraction_time: "time",
      },
    },
    l0_conversations_count: 100,
    total_memories_extracted: 45,
    ...overrides,
  });
}

async function writeJsonl(
  baseDir: string,
  subdirectory: string,
  fileName: string,
  lines: string[],
): Promise<void> {
  const directory = path.join(baseDir, subdirectory);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, fileName), `${lines.join("\n")}\n`, "utf-8");
}

function store(overrides: Partial<CheckpointCountStore> = {}): CheckpointCountStore {
  return {
    isDegraded: () => false,
    getCheckpointCounts: () => ({ l0Records: 42, l1Records: 20, filteredL1Records: 3 }),
    ...overrides,
  };
}

describe("CheckpointManager recalibration", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ckpt-recalibrate-"));
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("rebuilds all derived counters from a healthy store", async () => {
    await seedCheckpoint(dataDir, {});

    const result = await new CheckpointManager(dataDir).recalibrateFromStorage(store());
    const checkpoint = await new CheckpointManager(dataDir).read();

    expect(result.source).toBe("store");
    expect(checkpoint).toMatchObject({
      total_processed: 42,
      l0_conversations_count: 42,
      total_memories_extracted: 20,
      memories_since_last_persona: 3,
    });
  });

  it("preserves session cursors and non-derived checkpoint fields", async () => {
    await seedCheckpoint(dataDir, { scenes_processed: 7 });

    await new CheckpointManager(dataDir).recalibrateFromStorage(store());
    const checkpoint = await new CheckpointManager(dataDir).read();

    expect(checkpoint.scenes_processed).toBe(7);
    expect(checkpoint.runner_states.s1).toMatchObject({
      last_captured_timestamp: 1,
      last_l1_cursor: 2,
      last_scene_name: "scene",
    });
    expect(checkpoint.pipeline_states.s1.conversation_count).toBe(5);
  });

  it("falls back to valid JSONL records for a degraded store", async () => {
    await seedCheckpoint(dataDir, {});
    await writeJsonl(dataDir, "conversations", "2026-07-01.jsonl", [
      JSON.stringify({ id: "l0-1", sessionKey: "s1", recordedAt: "2026-07-01T00:00:00Z" }),
      JSON.stringify({ messages: [{ role: "user" }, { role: "assistant" }] }),
      "{bad-json",
    ]);
    await writeJsonl(dataDir, "records", "2026-07-01.jsonl", [
      JSON.stringify({ id: "old", sessionKey: "s1", updatedAt: "2026-07-01T00:00:00Z" }),
      JSON.stringify({ id: "new", sessionKey: "s1", updated_time: "2026-07-11T00:00:00Z" }),
      JSON.stringify({ id: "incomplete" }),
    ]);
    await writeJsonl(dataDir, "records", "notes.jsonl.bak", [
      JSON.stringify({ id: "ignored", sessionKey: "s1", updatedAt: "2026-07-12T00:00:00Z" }),
    ]);

    const result = await new CheckpointManager(dataDir).recalibrateFromStorage(
      store({ isDegraded: () => true }),
    );
    const checkpoint = await new CheckpointManager(dataDir).read();

    expect(result.source).toBe("jsonl");
    expect(checkpoint).toMatchObject({
      total_processed: 3,
      l0_conversations_count: 3,
      total_memories_extracted: 2,
      memories_since_last_persona: 1,
    });
  });

  it("preserves counters when a healthy store count fails", async () => {
    await seedCheckpoint(dataDir, {});
    await writeJsonl(dataDir, "conversations", "2026-07-01.jsonl", [
      JSON.stringify({ id: "l0", sessionKey: "s1", recordedAt: "2026-07-01T00:00:00Z" }),
    ]);
    await writeJsonl(dataDir, "records", "2026-07-01.jsonl", [
      JSON.stringify({ id: "l1", sessionKey: "s1", updatedAt: "2026-07-11T00:00:00Z" }),
    ]);

    const result = await new CheckpointManager(dataDir).recalibrateFromStorage(
      store({ getCheckpointCounts: () => ({ l0Records: Number.NaN, l1Records: 20, filteredL1Records: 3 }) }),
    );

    expect(result.source).toBe("store");
    expect((await new CheckpointManager(dataDir).read()).total_processed).toBe(100);
  });

  it("rebuilds a fresh checkpoint upward from JSONL during store degradation", async () => {
    await writeJsonl(dataDir, "conversations", "2026-07-01.jsonl", [
      JSON.stringify({ id: "l0", sessionKey: "s1", recordedAt: "2026-07-01T00:00:00Z" }),
    ]);
    await writeJsonl(dataDir, "records", "2026-07-01.jsonl", [
      JSON.stringify({ id: "l1", sessionKey: "s1", updatedAt: "2026-07-11T00:00:00Z" }),
    ]);

    await new CheckpointManager(dataDir).recalibrateFromStorage(
      store({ isDegraded: () => true }),
    );

    expect(await new CheckpointManager(dataDir).read()).toMatchObject({
      total_processed: 1,
      l0_conversations_count: 1,
      total_memories_extracted: 1,
      memories_since_last_persona: 1,
    });
  });

  it("treats missing JSONL directories as empty storage", async () => {
    await seedCheckpoint(dataDir, {});

    await new CheckpointManager(dataDir).recalibrateFromStorage();

    expect(await new CheckpointManager(dataDir).read()).toMatchObject({
      total_processed: 0,
      l0_conversations_count: 0,
      total_memories_extracted: 0,
      memories_since_last_persona: 0,
    });
  });

  it("subtracts only removed L1 records newer than the persona watermark", async () => {
    await seedCheckpoint(dataDir, {
      total_processed: 20,
      l0_conversations_count: 20,
      total_memories_extracted: 10,
      memories_since_last_persona: 4,
    });

    await new CheckpointManager(dataDir).applyCleanupDelta({
      l0Records: 3,
      l1Records: 5,
      l1RecordsSincePersona: 1,
    });

    expect(await new CheckpointManager(dataDir).read()).toMatchObject({
      total_processed: 17,
      l0_conversations_count: 17,
      total_memories_extracted: 5,
      memories_since_last_persona: 3,
    });
  });

  it("preserves concurrent L1 increments while applying cleanup deltas", async () => {
    await seedCheckpoint(dataDir, {
      total_memories_extracted: 10,
      memories_since_last_persona: 5,
    });
    const checkpoint = new CheckpointManager(dataDir);

    await Promise.all([
      checkpoint.applyCleanupDelta({ l1Records: 3, l1RecordsSincePersona: 1 }),
      checkpoint.markL1ExtractionComplete("s1", 2),
    ]);

    expect(await checkpoint.read()).toMatchObject({
      total_memories_extracted: 9,
      memories_since_last_persona: 6,
    });
  });

  it("uses L0 message-record units during capture", async () => {
    await seedCheckpoint(dataDir, {
      total_processed: 0,
      l0_conversations_count: 0,
    });
    const checkpoint = new CheckpointManager(dataDir);

    await checkpoint.captureAtomically("s1", undefined, async () => ({
      maxTimestamp: 100,
      messageCount: 3,
    }));

    expect(await checkpoint.read()).toMatchObject({
      total_processed: 3,
      l0_conversations_count: 3,
    });
  });
});
