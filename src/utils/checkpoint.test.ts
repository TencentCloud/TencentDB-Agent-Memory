import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CheckpointManager } from "./checkpoint.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-checkpoint-"));
  tempDirs.push(dir);
  return dir;
}

async function writeJsonl(
  dataDir: string,
  subdir: "conversations" | "records",
  fileName: string,
  lines: Array<Record<string, unknown> | string>,
): Promise<void> {
  const dir = path.join(dataDir, subdir);
  await fs.mkdir(dir, { recursive: true });
  const content = lines
    .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
    .join("\n");
  await fs.writeFile(path.join(dir, fileName), `${content}\n`, "utf-8");
}

function l0Message(
  id: string,
  recordedAt: string,
  sessionKey = "agent:test",
  sessionId = "session-1",
): Record<string, unknown> {
  return {
    sessionKey,
    sessionId,
    recordedAt,
    id,
    role: "user",
    content: `message ${id}`,
    timestamp: Date.parse(recordedAt),
  };
}

function l1Memory(
  id: string,
  sessionKey = "agent:test",
  sessionId = "session-1",
): Record<string, unknown> {
  return {
    id,
    content: `memory ${id}`,
    type: "episodic",
    priority: 50,
    sessionKey,
    sessionId,
  };
}

async function seedCheckpoint(
  manager: CheckpointManager,
  l0Count: number,
  l1Count: number,
): Promise<void> {
  const checkpoint = await manager.read();
  checkpoint.l0_conversations_count = l0Count;
  checkpoint.total_memories_extracted = l1Count;
  checkpoint.total_processed = 123;
  checkpoint.memories_since_last_persona = 7;
  await manager.write(checkpoint);
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("CheckpointManager.recalibrateFromDisk", () => {
  it("recounts retained L0 capture batches and L1 memory records", async () => {
    const dataDir = await makeTempDir();
    const manager = new CheckpointManager(dataDir);
    await seedCheckpoint(manager, 99, 88);

    const firstCaptureAt = "2026-07-30T08:00:00.000Z";
    await writeJsonl(dataDir, "conversations", "2026-07-30.jsonl", [
      l0Message("m1", firstCaptureAt),
      // Same capture timestamp and session: this is still one L0 batch.
      { ...l0Message("m2", firstCaptureAt), role: "assistant" },
      l0Message("m3", "2026-07-30T09:00:00.000Z"),
      {
        sessionKey: "agent:test",
        sessionId: "legacy-session",
        recordedAt: "2026-07-30T10:00:00.000Z",
        messageCount: 2,
        messages: [
          { role: "user", content: "legacy", timestamp: 1 },
          { role: "assistant", content: "legacy reply", timestamp: 2 },
        ],
      },
      "{not-json",
      {},
      "",
    ]);
    await writeJsonl(dataDir, "records", "2026-07-30.jsonl", [
      l1Memory("r1"),
      l1Memory("r2"),
      { record_id: "r3", content: "legacy memory" },
      "{not-json",
      {},
      "",
    ]);

    const result = await manager.recalibrateFromDisk();
    const checkpoint = await manager.read();

    expect(result.changed).toBe(true);
    expect(result.before).toEqual({
      l0ConversationsCount: 99,
      totalMemoriesExtracted: 88,
    });
    expect(result.after).toEqual({
      l0ConversationsCount: 3,
      totalMemoriesExtracted: 3,
    });
    expect(result.sources.l0).toEqual({
      ok: true,
      count: 3,
      skippedLines: 2,
    });
    expect(result.sources.l1).toEqual({
      ok: true,
      count: 3,
      skippedLines: 2,
    });
    expect(checkpoint.total_processed).toBe(123);
    expect(checkpoint.memories_since_last_persona).toBe(7);
  });

  it("repairs counters after manual JSONL pruning", async () => {
    const dataDir = await makeTempDir();
    const manager = new CheckpointManager(dataDir);
    const l0File = "2026-07-30.jsonl";
    const l1File = "2026-07-30.jsonl";

    await writeJsonl(dataDir, "conversations", l0File, [
      l0Message("m1", "2026-07-30T08:00:00.000Z"),
      l0Message("m2", "2026-07-30T09:00:00.000Z"),
    ]);
    await writeJsonl(dataDir, "records", l1File, [
      l1Memory("r1"),
      l1Memory("r2"),
    ]);
    await seedCheckpoint(manager, 2, 2);

    await writeJsonl(dataDir, "conversations", l0File, [
      l0Message("m2", "2026-07-30T09:00:00.000Z"),
    ]);
    await writeJsonl(dataDir, "records", l1File, [l1Memory("r2")]);

    const result = await manager.recalibrateFromDisk();

    expect(result.after).toEqual({
      l0ConversationsCount: 1,
      totalMemoriesExtracted: 1,
    });
    expect((await manager.read()).l0_conversations_count).toBe(1);
    expect((await manager.read()).total_memories_extracted).toBe(1);
  });

  it("repairs counters after one session's JSONL data is reset", async () => {
    const dataDir = await makeTempDir();
    const manager = new CheckpointManager(dataDir);
    const l0File = "2026-07-30.jsonl";
    const l1File = "2026-07-30.jsonl";

    const retainedL0 = l0Message(
      "b1",
      "2026-07-30T10:00:00.000Z",
      "agent:b",
      "session-b",
    );
    const retainedL1 = l1Memory("b1", "agent:b", "session-b");

    await writeJsonl(dataDir, "conversations", l0File, [
      l0Message(
        "a1",
        "2026-07-30T08:00:00.000Z",
        "agent:a",
        "session-a",
      ),
      l0Message(
        "a2",
        "2026-07-30T09:00:00.000Z",
        "agent:a",
        "session-a",
      ),
      retainedL0,
    ]);
    await writeJsonl(dataDir, "records", l1File, [
      l1Memory("a1", "agent:a", "session-a"),
      l1Memory("a2", "agent:a", "session-a"),
      retainedL1,
    ]);

    const checkpoint = await manager.read();
    checkpoint.l0_conversations_count = 3;
    checkpoint.total_memories_extracted = 3;
    checkpoint.runner_states = {
      "agent:a": {
        last_captured_timestamp: 100,
        last_l1_cursor: 200,
        last_scene_name: "scene-a",
      },
      "agent:b": {
        last_captured_timestamp: 300,
        last_l1_cursor: 400,
        last_scene_name: "scene-b",
      },
    };
    checkpoint.pipeline_states = {
      "agent:a": {
        conversation_count: 2,
        last_extraction_time: "2026-07-30T09:00:00.000Z",
        last_extraction_updated_time: "2026-07-30T09:00:00.000Z",
        last_active_time: 100,
        l2_pending_l1_count: 1,
        warmup_threshold: 2,
        l2_last_extraction_time: "2026-07-30T09:00:00.000Z",
      },
      "agent:b": {
        conversation_count: 1,
        last_extraction_time: "2026-07-30T10:00:00.000Z",
        last_extraction_updated_time: "2026-07-30T10:00:00.000Z",
        last_active_time: 300,
        l2_pending_l1_count: 0,
        warmup_threshold: 4,
        l2_last_extraction_time: "2026-07-30T10:00:00.000Z",
      },
    };
    await manager.write(checkpoint);

    // Simulate an external reset of agent:a while preserving agent:b's data.
    await writeJsonl(dataDir, "conversations", l0File, [retainedL0]);
    await writeJsonl(dataDir, "records", l1File, [retainedL1]);

    const result = await manager.recalibrateFromDisk();
    const repaired = await manager.read();

    expect(result.after).toEqual({
      l0ConversationsCount: 1,
      totalMemoriesExtracted: 1,
    });
    expect(repaired.runner_states).toEqual(checkpoint.runner_states);
    expect(repaired.pipeline_states).toEqual(checkpoint.pipeline_states);
  });

  it("treats missing L0/L1 directories as empty data", async () => {
    const dataDir = await makeTempDir();
    const manager = new CheckpointManager(dataDir);
    await seedCheckpoint(manager, 4, 5);

    const result = await manager.recalibrateFromDisk();

    expect(result.sources.l0.ok).toBe(true);
    expect(result.sources.l1.ok).toBe(true);
    expect(result.after).toEqual({
      l0ConversationsCount: 0,
      totalMemoriesExtracted: 0,
    });
  });

  it("preserves one layer when that data source cannot be read", async () => {
    const dataDir = await makeTempDir();
    const manager = new CheckpointManager(dataDir);
    const warnings: string[] = [];
    const loggingManager = new CheckpointManager(dataDir, {
      info() {},
      warn(message) {
        warnings.push(message);
      },
    });
    await seedCheckpoint(manager, 9, 9);

    // A regular file where a directory is expected makes only the L0 scan fail.
    await fs.writeFile(
      path.join(dataDir, "conversations"),
      "not a directory",
      "utf-8",
    );
    await writeJsonl(dataDir, "records", "2026-07-30.jsonl", [
      l1Memory("r1"),
    ]);

    const result = await loggingManager.recalibrateFromDisk();
    const checkpoint = await manager.read();

    expect(result.sources.l0.ok).toBe(false);
    expect(result.sources.l1.ok).toBe(true);
    expect(checkpoint.l0_conversations_count).toBe(9);
    expect(checkpoint.total_memories_extracted).toBe(1);
    expect(warnings.some((message) => message.includes("L0 recount failed"))).toBe(
      true,
    );
  });

  it("does not rewrite counters when disk and checkpoint already agree", async () => {
    const dataDir = await makeTempDir();
    const manager = new CheckpointManager(dataDir);
    await writeJsonl(dataDir, "conversations", "2026-07-30.jsonl", [
      l0Message("m1", "2026-07-30T08:00:00.000Z"),
    ]);
    await writeJsonl(dataDir, "records", "2026-07-30.jsonl", [
      l1Memory("r1"),
    ]);
    await seedCheckpoint(manager, 1, 1);

    const result = await manager.recalibrateFromDisk();

    expect(result.changed).toBe(false);
    expect(result.before).toEqual(result.after);
  });
});
