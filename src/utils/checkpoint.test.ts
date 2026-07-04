import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CheckpointManager, recalibrateCheckpointFromStore } from "./checkpoint.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-checkpoint-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("CheckpointManager", () => {
  it("recalibrates drifted aggregate counters from actual store counts", async () => {
    const dataDir = await makeTempDir();
    const checkpoint = new CheckpointManager(dataDir);

    await checkpoint.markL1ExtractionComplete("session-a", 9, 123);
    await checkpoint.captureAtomically("session-a", undefined, async () => ({
      maxTimestamp: 456,
      messageCount: 3,
    }));

    await checkpoint.recalibrate({
      totalMemoriesExtracted: 4,
      l0ConversationsCount: 2,
    });

    const cp = await checkpoint.read();
    expect(cp.total_memories_extracted).toBe(4);
    expect(cp.l0_conversations_count).toBe(2);
    expect(cp.memories_since_last_persona).toBe(4);
    expect(cp.total_processed).toBe(3);
  });

  it("recalibrates aggregate counters from store count methods", async () => {
    const dataDir = await makeTempDir();
    const checkpoint = new CheckpointManager(dataDir);

    await checkpoint.markL1ExtractionComplete("session-a", 12, 123);
    await checkpoint.captureAtomically("session-a", undefined, async () => ({
      maxTimestamp: 456,
      messageCount: 3,
    }));

    await recalibrateCheckpointFromStore(dataDir, {
      countL0: () => 5,
      countL1: () => 7,
    });

    const cp = await checkpoint.read();
    expect(cp.l0_conversations_count).toBe(5);
    expect(cp.total_memories_extracted).toBe(7);
    expect(cp.memories_since_last_persona).toBe(7);
  });

  it("prefers local JSONL counts so manual pruning is reflected", async () => {
    const dataDir = await makeTempDir();
    const checkpoint = new CheckpointManager(dataDir);
    const recordsDir = path.join(dataDir, "records");
    const conversationsDir = path.join(dataDir, "conversations");

    await fs.mkdir(recordsDir, { recursive: true });
    await fs.mkdir(conversationsDir, { recursive: true });
    await fs.writeFile(
      path.join(recordsDir, "2026-07-05.jsonl"),
      "{\"id\":\"m1\"}\n{\"id\":\"m2\"}\n{\"id\":\"m3\"}\n{\"id\":\"m4\"}\n",
    );
    await fs.writeFile(
      path.join(conversationsDir, "2026-07-05.jsonl"),
      "{\"id\":\"c1\"}\n{\"id\":\"c2\"}\n",
    );

    await checkpoint.markL1ExtractionComplete("session-a", 12, 123);
    await checkpoint.captureAtomically("session-a", undefined, async () => ({
      maxTimestamp: 456,
      messageCount: 3,
    }));

    const store = {
      countL0: () => 99,
      countL1: () => 99,
    };

    await recalibrateCheckpointFromStore(dataDir, store);
    let cp = await checkpoint.read();
    expect(cp.l0_conversations_count).toBe(2);
    expect(cp.total_memories_extracted).toBe(4);
    expect(cp.memories_since_last_persona).toBe(4);

    await fs.writeFile(path.join(recordsDir, "2026-07-05.jsonl"), "{\"id\":\"m1\"}\n");
    await fs.writeFile(path.join(conversationsDir, "2026-07-05.jsonl"), "{\"id\":\"c1\"}\n");

    await recalibrateCheckpointFromStore(dataDir, store);
    cp = await checkpoint.read();
    expect(cp.l0_conversations_count).toBe(1);
    expect(cp.total_memories_extracted).toBe(1);
    expect(cp.memories_since_last_persona).toBe(1);
    expect(cp.total_processed).toBe(1);
  });

  it("bounds L1 cursors after a local history rollback", async () => {
    const dataDir = await makeTempDir();
    const checkpoint = new CheckpointManager(dataDir);
    const conversationsDir = path.join(dataDir, "conversations");
    const recordsDir = path.join(dataDir, "records");

    await fs.mkdir(conversationsDir, { recursive: true });
    await fs.mkdir(recordsDir, { recursive: true });
    await fs.writeFile(
      path.join(conversationsDir, "2026-07-05.jsonl"),
      [
        JSON.stringify({ id: "c1", sessionKey: "session-a", timestamp: 1000, recordedAt: "2026-07-05T00:00:01.000Z" }),
        JSON.stringify({ id: "c2", sessionKey: "session-a", timestamp: 2000, recordedAt: "2026-07-05T00:00:02.000Z" }),
      ].join("\n") + "\n",
    );
    await fs.writeFile(path.join(recordsDir, "2026-07-05.jsonl"), "{\"id\":\"m1\"}\n");

    await checkpoint.markL1ExtractionComplete("session-a", 5, 9000);
    await checkpoint.captureAtomically("session-a", undefined, async () => ({
      maxTimestamp: 9000,
      messageCount: 5,
    }));

    await recalibrateCheckpointFromStore(dataDir, {
      countL0: () => 99,
      countL1: () => 99,
    });

    const cp = await checkpoint.read();
    expect(cp.total_processed).toBe(2);
    expect(cp.last_captured_timestamp).toBe(2000);
    expect(cp.runner_states["session-a"]?.last_captured_timestamp).toBe(2000);
    expect(cp.runner_states["session-a"]?.last_l1_cursor).toBe(2000);
  });

  it("bounds L2 cursors after local memory records roll back", async () => {
    const dataDir = await makeTempDir();
    const checkpoint = new CheckpointManager(dataDir);
    const recordsDir = path.join(dataDir, "records");

    await fs.mkdir(recordsDir, { recursive: true });
    await fs.writeFile(
      path.join(recordsDir, "2026-07-05.jsonl"),
      [
        JSON.stringify({ id: "m1", sessionKey: "session-a", updatedAt: "2026-07-05T00:00:01.000Z" }),
        JSON.stringify({ id: "m2", sessionKey: "session-a", updatedAt: "2026-07-05T00:00:02.000Z" }),
      ].join("\n") + "\n",
    );

    await checkpoint.mergePipelineStates({
      "session-a": {
        conversation_count: 0,
        last_extraction_time: "",
        last_extraction_updated_time: "2026-07-05T00:00:09.000Z",
        last_active_time: 0,
        l2_pending_l1_count: 0,
        warmup_threshold: 0,
        l2_last_extraction_time: "",
      },
    });

    await recalibrateCheckpointFromStore(dataDir, {
      countL0: () => 0,
      countL1: () => 99,
    });

    const cp = await checkpoint.read();
    expect(cp.total_memories_extracted).toBe(2);
    expect(cp.pipeline_states["session-a"]?.last_extraction_updated_time).toBe("2026-07-05T00:00:02.000Z");
  });

  it("clears cursors when local shards are fully pruned", async () => {
    const dataDir = await makeTempDir();
    const checkpoint = new CheckpointManager(dataDir);
    const conversationsDir = path.join(dataDir, "conversations");
    const recordsDir = path.join(dataDir, "records");

    await fs.mkdir(conversationsDir, { recursive: true });
    await fs.mkdir(recordsDir, { recursive: true });
    await fs.writeFile(path.join(conversationsDir, "2026-07-05.jsonl"), "");
    await fs.writeFile(path.join(recordsDir, "2026-07-05.jsonl"), "");

    await checkpoint.markL1ExtractionComplete("session-a", 5, 9000);
    await checkpoint.captureAtomically("session-a", undefined, async () => ({
      maxTimestamp: 9000,
      messageCount: 5,
    }));
    await checkpoint.mergePipelineStates({
      "session-a": {
        conversation_count: 0,
        last_extraction_time: "",
        last_extraction_updated_time: "2026-07-05T00:00:09.000Z",
        last_active_time: 0,
        l2_pending_l1_count: 0,
        warmup_threshold: 0,
        l2_last_extraction_time: "",
      },
    });

    await recalibrateCheckpointFromStore(dataDir, {
      countL0: () => 99,
      countL1: () => 99,
    });

    const cp = await checkpoint.read();
    expect(cp.total_processed).toBe(0);
    expect(cp.total_memories_extracted).toBe(0);
    expect(cp.last_captured_timestamp).toBe(0);
    expect(cp.runner_states["session-a"]?.last_captured_timestamp).toBe(0);
    expect(cp.runner_states["session-a"]?.last_l1_cursor).toBe(0);
    expect(cp.pipeline_states["session-a"]?.last_extraction_updated_time).toBe("");
  });
});
