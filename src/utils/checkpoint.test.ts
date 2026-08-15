import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PersonaTrigger } from "../core/persona/persona-trigger.js";
import {
  CheckpointManager,
  type CheckpointCountStore,
} from "./checkpoint.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-checkpoint-"));
  tempDirs.push(dir);
  return dir;
}

async function writeShard(
  baseDir: string,
  subdirectory: "conversations" | "records",
  lines: string[],
): Promise<string> {
  const directory = path.join(baseDir, subdirectory);
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, "2026-07-15.jsonl");
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf-8");
  return filePath;
}

function l0Line(id: string, recordedAt: string): string {
  return JSON.stringify({
    id,
    sessionKey: "session-a",
    sessionId: "conversation-a",
    recordedAt,
    role: "user",
    content: "hello",
    timestamp: Date.parse(recordedAt),
  });
}

function l1Line(id: string, updatedAt: string): string {
  return JSON.stringify({
    id,
    sessionKey: "session-a",
    sessionId: "conversation-a",
    content: "memory",
    updatedAt,
    createdAt: updatedAt,
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("CheckpointManager recalibration", () => {
  it("keeps L0 counters in message-record units", async () => {
    const checkpoint = new CheckpointManager(await makeTempDir());

    await checkpoint.captureAtomically("session-a", undefined, async () => ({
      maxTimestamp: 100,
      messageCount: 3,
    }));

    const current = await checkpoint.read();
    expect(current.total_processed).toBe(3);
    expect(current.l0_conversations_count).toBe(3);
  });

  it("uses a healthy store and preserves all cursor state", async () => {
    const dataDir = await makeTempDir();
    const checkpoint = new CheckpointManager(dataDir);
    const seeded = await checkpoint.read();
    seeded.total_processed = 99;
    seeded.l0_conversations_count = 12;
    seeded.total_memories_extracted = 40;
    seeded.memories_since_last_persona = 30;
    seeded.last_persona_time = "2026-07-15T10:00:00.000Z";
    seeded.last_persona_at = 77;
    seeded.runner_states["session-a"] = {
      last_captured_timestamp: 111,
      last_l1_cursor: 222,
      last_scene_name: "scene-a",
    };
    seeded.pipeline_states["session-a"] = {
      conversation_count: 3,
      last_extraction_time: "2026-07-15T09:00:00.000Z",
      last_extraction_updated_time: "2026-07-15T09:00:00.000Z",
      last_active_time: 333,
      l2_pending_l1_count: 1,
      warmup_threshold: 2,
      l2_last_extraction_time: "",
    };
    await checkpoint.write(seeded);

    const queryL1Records = vi.fn(() => [{}, {}]);
    const store: CheckpointCountStore = {
      isDegraded: () => false,
      countL0: () => 8,
      countL1: () => 5,
      queryL1Records,
    };

    const result = await checkpoint.recalibrateFromStorage(store, "test");
    const current = await checkpoint.read();

    expect(result.source).toBe("store");
    expect(result.before.total_processed).toBe(99);
    expect(result.after).toEqual({
      total_processed: 8,
      l0_conversations_count: 8,
      total_memories_extracted: 5,
      memories_since_last_persona: 2,
    });
    expect(queryL1Records).toHaveBeenCalledWith({
      updatedAfter: "2026-07-15T10:00:00.000Z",
    });
    expect(current.last_persona_at).toBe(77);
    expect(current.last_persona_time).toBe("2026-07-15T10:00:00.000Z");
    expect(current.runner_states["session-a"].last_l1_cursor).toBe(222);
    expect(current.pipeline_states["session-a"].conversation_count).toBe(3);
  });

  it("recounts valid JSONL records after manual pruning", async () => {
    const dataDir = await makeTempDir();
    const checkpoint = new CheckpointManager(dataDir);
    const seeded = await checkpoint.read();
    seeded.total_processed = 20;
    seeded.l0_conversations_count = 20;
    seeded.total_memories_extracted = 10;
    seeded.memories_since_last_persona = 10;
    seeded.last_persona_time = "2026-07-15T10:00:00.000Z";
    await checkpoint.write(seeded);

    const l0Path = await writeShard(dataDir, "conversations", [
      l0Line("l0-1", "2026-07-15T09:00:00.000Z"),
      l0Line("l0-2", "2026-07-15T11:00:00.000Z"),
      "{bad-json",
      JSON.stringify({ id: "incomplete" }),
    ]);
    const l1Path = await writeShard(dataDir, "records", [
      l1Line("l1-old", "2026-07-15T09:00:00.000Z"),
      l1Line("l1-new-1", "2026-07-15T11:00:00.000Z"),
      l1Line("l1-new-2", "2026-07-15T12:00:00.000Z"),
      "{bad-json",
    ]);

    await checkpoint.recalibrateFromStorage(undefined, "jsonl-before-prune");
    expect(await checkpoint.read()).toMatchObject({
      total_processed: 2,
      l0_conversations_count: 2,
      total_memories_extracted: 3,
      memories_since_last_persona: 2,
    });

    await fs.writeFile(l0Path, `${l0Line("l0-2", "2026-07-15T11:00:00.000Z")}\n`, "utf-8");
    await fs.writeFile(l1Path, `${l1Line("l1-new-2", "2026-07-15T12:00:00.000Z")}\n`, "utf-8");
    await checkpoint.recalibrateFromStorage(undefined, "jsonl-after-prune");

    expect(await checkpoint.read()).toMatchObject({
      total_processed: 1,
      l0_conversations_count: 1,
      total_memories_extracted: 1,
      memories_since_last_persona: 1,
    });
  });

  it("recovers counters when the checkpoint file is corrupt", async () => {
    const dataDir = await makeTempDir();
    await writeShard(dataDir, "conversations", [
      l0Line("l0-1", "2026-07-15T11:00:00.000Z"),
    ]);
    await writeShard(dataDir, "records", [
      l1Line("l1-1", "2026-07-15T11:00:00.000Z"),
    ]);
    const metadataDir = path.join(dataDir, ".metadata");
    await fs.mkdir(metadataDir, { recursive: true });
    await fs.writeFile(path.join(metadataDir, "recall_checkpoint.json"), "{broken", "utf-8");

    const checkpoint = new CheckpointManager(dataDir);
    await checkpoint.recalibrateFromStorage();

    expect(await checkpoint.read()).toMatchObject({
      total_processed: 1,
      l0_conversations_count: 1,
      total_memories_extracted: 1,
      memories_since_last_persona: 1,
    });
  });

  it("falls back to JSONL when a healthy store count throws", async () => {
    const dataDir = await makeTempDir();
    await writeShard(dataDir, "conversations", [
      l0Line("l0-1", "2026-07-15T11:00:00.000Z"),
    ]);
    await writeShard(dataDir, "records", [
      l1Line("l1-1", "2026-07-15T11:00:00.000Z"),
    ]);

    const checkpoint = new CheckpointManager(dataDir);
    const result = await checkpoint.recalibrateFromStorage({
      isDegraded: () => false,
      countL0: () => {
        throw new Error("count unavailable");
      },
      countL1: () => 99,
      queryL1Records: () => [],
    });

    expect(result.source).toBe("jsonl");
    expect(result.after).toEqual({
      total_processed: 1,
      l0_conversations_count: 1,
      total_memories_extracted: 1,
      memories_since_last_persona: 1,
    });
  });

  it("resets stale counters when persistence directories are missing", async () => {
    const dataDir = await makeTempDir();
    const checkpoint = new CheckpointManager(dataDir);
    await checkpoint.recalibrateCounts({
      l0Records: 9,
      l1Records: 7,
      l1RecordsSincePersona: 5,
    });

    const result = await checkpoint.recalibrateFromStorage({
      isDegraded: () => true,
      countL0: () => 99,
      countL1: () => 99,
      queryL1Records: () => [{}],
    });

    expect(result.source).toBe("jsonl");
    expect(result.after).toEqual({
      total_processed: 0,
      l0_conversations_count: 0,
      total_memories_extracted: 0,
      memories_since_last_persona: 0,
    });
  });

  it("applies cleanup deltas without losing concurrent increments", async () => {
    const checkpoint = new CheckpointManager(await makeTempDir());
    await checkpoint.recalibrateCounts({
      l0Records: 10,
      l1Records: 6,
      l1RecordsSincePersona: 4,
    });

    await Promise.all([
      checkpoint.applyCleanupDelta({ l0Records: 2, l1Records: 2 }),
      checkpoint.captureAtomically("session-a", undefined, async () => ({
        maxTimestamp: 100,
        messageCount: 3,
      })),
      checkpoint.markL1ExtractionComplete("session-a", 1),
    ]);

    expect(await checkpoint.read()).toMatchObject({
      total_processed: 11,
      l0_conversations_count: 11,
      total_memories_extracted: 5,
      memories_since_last_persona: 3,
    });
  });

  it("prevents a stale Persona threshold from firing after recalibration", async () => {
    const dataDir = await makeTempDir();
    const checkpoint = new CheckpointManager(dataDir);
    const seeded = await checkpoint.read();
    seeded.total_memories_extracted = 10;
    seeded.memories_since_last_persona = 10;
    seeded.last_persona_time = "2026-07-15T10:00:00.000Z";
    await checkpoint.write(seeded);

    await checkpoint.recalibrateFromStorage({
      isDegraded: () => false,
      countL0: () => 4,
      countL1: () => 4,
      queryL1Records: () => [{}, {}],
    });

    const trigger = new PersonaTrigger({ dataDir, interval: 3 });
    expect(await trigger.shouldGenerate()).toEqual({ should: false, reason: "" });
  });
});
