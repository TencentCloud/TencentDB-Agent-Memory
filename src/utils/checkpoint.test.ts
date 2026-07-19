import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CheckpointManager,
  countL0CaptureRoundsFromJsonl,
  countL1RecordsFromJsonl,
} from "./checkpoint.js";

describe("checkpoint recalibration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-checkpoint-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeCheckpoint(values: {
    total_memories_extracted?: number;
    l0_conversations_count?: number;
    memories_since_last_persona?: number;
  }): Promise<void> {
    const metaDir = path.join(tmpDir, ".metadata");
    await fs.mkdir(metaDir, { recursive: true });
    await fs.writeFile(
      path.join(metaDir, "recall_checkpoint.json"),
      JSON.stringify(values),
      "utf-8",
    );
  }

  async function appendShard(relativeDir: string, lines: string[]): Promise<void> {
    const dir = path.join(tmpDir, relativeDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "2026-07-09.jsonl"), `${lines.join("\n")}\n`, "utf-8");
  }

  it("counts unique L1 ids from date-named JSONL shards", async () => {
    await appendShard("records", [
      JSON.stringify({ id: "m1", content: "first" }),
      JSON.stringify({ id: "m2", content: "second" }),
      JSON.stringify({ id: "m1", content: "updated" }),
      "not-json",
    ]);
    await fs.writeFile(path.join(tmpDir, "records", "notes.txt"), JSON.stringify({ id: "ignored" }), "utf-8");

    await expect(countL1RecordsFromJsonl(tmpDir)).resolves.toBe(2);
  });

  it("counts L0 capture rounds by sessionKey and recordedAt", async () => {
    await appendShard("conversations", [
      JSON.stringify({ sessionKey: "s1", recordedAt: "2026-07-09T10:00:00.000Z", role: "user" }),
      JSON.stringify({ sessionKey: "s1", recordedAt: "2026-07-09T10:00:00.000Z", role: "assistant" }),
      JSON.stringify({ sessionKey: "s1", recordedAt: "2026-07-09T10:01:00.000Z", role: "user" }),
      JSON.stringify({ sessionKey: "s2", recordedAt: "2026-07-09T10:01:00.000Z", role: "user" }),
      JSON.stringify({ sessionKey: "", recordedAt: "2026-07-09T10:02:00.000Z", role: "user" }),
    ]);

    await expect(countL0CaptureRoundsFromJsonl(tmpDir)).resolves.toBe(3);
  });

  it("recalibrates drifted counters from persisted data", async () => {
    await appendShard("records", [
      JSON.stringify({ id: "m1", content: "first" }),
      JSON.stringify({ id: "m2", content: "second" }),
    ]);
    await appendShard("conversations", [
      JSON.stringify({ sessionKey: "s1", recordedAt: "2026-07-09T10:00:00.000Z", role: "user" }),
      JSON.stringify({ sessionKey: "s1", recordedAt: "2026-07-09T10:00:00.000Z", role: "assistant" }),
    ]);
    await writeCheckpoint({
      total_memories_extracted: 7,
      l0_conversations_count: 5,
      memories_since_last_persona: 4,
    });

    const manager = new CheckpointManager(tmpDir);
    const result = await manager.recalibrate({ dataDir: tmpDir });
    const cp = await manager.read();

    expect(result).toMatchObject({
      adjusted: true,
      totalMemoriesBefore: 7,
      totalMemoriesAfter: 2,
      l0ConversationsBefore: 5,
      l0ConversationsAfter: 1,
      memoriesSinceLastPersonaBefore: 4,
      memoriesSinceLastPersonaAfter: 0,
    });
    expect(cp.total_memories_extracted).toBe(2);
    expect(cp.l0_conversations_count).toBe(1);
    expect(cp.memories_since_last_persona).toBe(0);
  });

  it("keeps remaining persona interval progress after partial L1 cleanup drift", async () => {
    await appendShard("records", [
      JSON.stringify({ id: "m1", content: "first" }),
      JSON.stringify({ id: "m2", content: "second" }),
      JSON.stringify({ id: "m3", content: "third" }),
    ]);
    await writeCheckpoint({
      total_memories_extracted: 5,
      l0_conversations_count: 0,
      memories_since_last_persona: 4,
    });

    const manager = new CheckpointManager(tmpDir);
    await manager.recalibrate({ dataDir: tmpDir });

    const cp = await manager.read();
    expect(cp.total_memories_extracted).toBe(3);
    expect(cp.memories_since_last_persona).toBe(2);
  });

  it("prefers vectorStore.countL1 over JSONL for active L1 rows", async () => {
    await appendShard("records", [
      JSON.stringify({ id: "stale-jsonl", content: "stale" }),
    ]);
    await writeCheckpoint({ total_memories_extracted: 99 });

    const manager = new CheckpointManager(tmpDir);
    const result = await manager.recalibrate({
      dataDir: tmpDir,
      vectorStore: { countL1: () => 42 },
    });

    expect(result.totalMemoriesAfter).toBe(42);
    await expect(manager.read()).resolves.toMatchObject({ total_memories_extracted: 42 });
  });

  it("falls back to JSONL when vectorStore count fails", async () => {
    await appendShard("records", [
      JSON.stringify({ id: "m1", content: "first" }),
    ]);
    await writeCheckpoint({ total_memories_extracted: 10 });

    const manager = new CheckpointManager(tmpDir);
    await manager.recalibrate({
      dataDir: tmpDir,
      vectorStore: {
        countL1: () => {
          throw new Error("store unavailable");
        },
      },
    });

    await expect(manager.read()).resolves.toMatchObject({ total_memories_extracted: 1 });
  });

  it("reports unchanged when checkpoint already matches data", async () => {
    await writeCheckpoint({
      total_memories_extracted: 0,
      l0_conversations_count: 0,
      memories_since_last_persona: 0,
    });

    const manager = new CheckpointManager(tmpDir);
    const result = await manager.recalibrate({ dataDir: tmpDir });

    expect(result.adjusted).toBe(false);
  });
});
