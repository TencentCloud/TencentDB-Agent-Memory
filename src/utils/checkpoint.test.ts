import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  CheckpointManager,
  countL0CaptureRoundsFromJsonl,
  countL1RecordsFromJsonl,
} from "./checkpoint.js";

describe("checkpoint recalibrate", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-test-"));
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
      JSON.stringify({
        total_memories_extracted: values.total_memories_extracted ?? 0,
        l0_conversations_count: values.l0_conversations_count ?? 0,
        memories_since_last_persona: values.memories_since_last_persona ?? 0,
      }),
      "utf-8",
    );
  }

  it("counts unique L1 record IDs from JSONL shards", async () => {
    const recordsDir = path.join(tmpDir, "records");
    await fs.mkdir(recordsDir, { recursive: true });
    await fs.writeFile(
      path.join(recordsDir, "2026-07-01.jsonl"),
      [
        JSON.stringify({ id: "m1", content: "a" }),
        JSON.stringify({ id: "m2", content: "b" }),
        JSON.stringify({ id: "m1", content: "a-updated" }),
      ].join("\n") + "\n",
      "utf-8",
    );

    expect(await countL1RecordsFromJsonl(tmpDir)).toBe(2);
  });

  it("counts L0 capture rounds by (sessionKey, recordedAt) batches", async () => {
    const conversationsDir = path.join(tmpDir, "conversations");
    await fs.mkdir(conversationsDir, { recursive: true });
    await fs.writeFile(
      path.join(conversationsDir, "2026-07-01.jsonl"),
      [
        JSON.stringify({ sessionKey: "s1", recordedAt: "2026-07-01T10:00:00.000Z", role: "user", content: "hi" }),
        JSON.stringify({ sessionKey: "s1", recordedAt: "2026-07-01T10:00:00.000Z", role: "assistant", content: "hello" }),
        JSON.stringify({ sessionKey: "s1", recordedAt: "2026-07-01T11:00:00.000Z", role: "user", content: "bye" }),
      ].join("\n") + "\n",
      "utf-8",
    );

    expect(await countL0CaptureRoundsFromJsonl(tmpDir)).toBe(2);
  });

  it("recalibrate fixes drifted counters from actual JSONL data", async () => {
    const recordsDir = path.join(tmpDir, "records");
    const conversationsDir = path.join(tmpDir, "conversations");
    await fs.mkdir(recordsDir, { recursive: true });
    await fs.mkdir(conversationsDir, { recursive: true });

    await fs.writeFile(
      path.join(recordsDir, "2026-07-01.jsonl"),
      [
        JSON.stringify({ id: "m1", content: "one" }),
        JSON.stringify({ id: "m2", content: "two" }),
      ].join("\n") + "\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(conversationsDir, "2026-07-01.jsonl"),
      JSON.stringify({
        sessionKey: "s1",
        recordedAt: "2026-07-01T10:00:00.000Z",
        role: "user",
        content: "hi",
      }) + "\n",
      "utf-8",
    );

    await writeCheckpoint({
      total_memories_extracted: 50,
      l0_conversations_count: 10,
      memories_since_last_persona: 12,
    });

    const manager = new CheckpointManager(tmpDir);
    const result = await manager.recalibrate({ dataDir: tmpDir });

    expect(result.adjusted).toBe(true);
    expect(result.totalMemoriesBefore).toBe(50);
    expect(result.totalMemoriesAfter).toBe(2);
    expect(result.l0ConversationsBefore).toBe(10);
    expect(result.l0ConversationsAfter).toBe(1);

    const cp = await manager.read();
    expect(cp.total_memories_extracted).toBe(2);
    expect(cp.l0_conversations_count).toBe(1);
    expect(cp.memories_since_last_persona).toBe(0);
  });

  it("prefers vectorStore.countL1 over JSONL when available", async () => {
    const recordsDir = path.join(tmpDir, "records");
    await fs.mkdir(recordsDir, { recursive: true });
    await fs.writeFile(
      path.join(recordsDir, "2026-07-01.jsonl"),
      JSON.stringify({ id: "m1", content: "stale-jsonl" }) + "\n",
      "utf-8",
    );

    await writeCheckpoint({ total_memories_extracted: 99 });

    const manager = new CheckpointManager(tmpDir);
    const result = await manager.recalibrate({
      dataDir: tmpDir,
      vectorStore: { countL1: () => 42 },
    });

    expect(result.adjusted).toBe(true);
    expect(result.totalMemoriesAfter).toBe(42);

    const cp = await manager.read();
    expect(cp.total_memories_extracted).toBe(42);
  });

  it("leaves counters unchanged when already accurate", async () => {
    await writeCheckpoint({
      total_memories_extracted: 0,
      l0_conversations_count: 0,
    });

    const manager = new CheckpointManager(tmpDir);
    const result = await manager.recalibrate({ dataDir: tmpDir });

    expect(result.adjusted).toBe(false);
    expect(result.totalMemoriesAfter).toBe(0);
    expect(result.l0ConversationsAfter).toBe(0);
  });
});
