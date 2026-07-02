import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CheckpointManager } from "./checkpoint.js";

const tempDirs: string[] = [];

async function makeTempDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-checkpoint-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "conversations"), { recursive: true });
  await fs.mkdir(path.join(dir, "records"), { recursive: true });
  await fs.mkdir(path.join(dir, ".metadata"), { recursive: true });
  return dir;
}

describe("CheckpointManager recalibration", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("recounts persisted JSONL records and decreases drifted counters", async () => {
    const dataDir = await makeTempDataDir();
    const checkpoint = new CheckpointManager(dataDir);

    await checkpoint.write({
      last_captured_timestamp: 123,
      total_processed: 9,
      last_persona_at: 0,
      last_persona_time: "",
      request_persona_update: false,
      persona_update_reason: "",
      memories_since_last_persona: 40,
      scenes_processed: 0,
      runner_states: {},
      pipeline_states: {},
      l0_conversations_count: 50,
      total_memories_extracted: 45,
    });
    await fs.writeFile(
      path.join(dataDir, "conversations", "2026-07-01.jsonl"),
      [
        JSON.stringify({ sessionKey: "s1", sessionId: "a", recordedAt: "2026-07-01T10:00:00.000Z" }),
        JSON.stringify({ sessionKey: "s1", sessionId: "a", recordedAt: "2026-07-01T10:00:00.000Z" }),
        JSON.stringify({ sessionKey: "s1", sessionId: "a", recordedAt: "2026-07-01T10:05:00.000Z" }),
        "",
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(path.join(dataDir, "records", "2026-07-01.jsonl"), "{}\n{}\n{}\n", "utf-8");

    const recalibrated = await checkpoint.recalibrate();

    expect(recalibrated.l0_conversations_count).toBe(2);
    expect(recalibrated.total_memories_extracted).toBe(3);
    expect(recalibrated.total_processed).toBe(9);
    expect(recalibrated.memories_since_last_persona).toBe(3);
  });

  it("counts captured L0 message records so incremental updates match recalibration", async () => {
    const dataDir = await makeTempDataDir();
    const checkpoint = new CheckpointManager(dataDir);

    await checkpoint.captureAtomically("session-a", undefined, async () => {
      await fs.writeFile(
        path.join(dataDir, "conversations", "2026-07-01.jsonl"),
        [
          JSON.stringify({ sessionKey: "session-a", sessionId: "turn-1", recordedAt: "2026-07-01T10:00:00.000Z" }),
          JSON.stringify({ sessionKey: "session-a", sessionId: "turn-1", recordedAt: "2026-07-01T10:00:00.000Z" }),
          "",
        ].join("\n"),
        "utf-8",
      );
      return {
        maxTimestamp: 200,
        messageCount: 2,
      };
    });

    const cp = await checkpoint.read();
    expect(cp.l0_conversations_count).toBe(1);
    expect(cp.total_processed).toBe(2);

    const recalibrated = await checkpoint.recalibrate();
    expect(recalibrated.l0_conversations_count).toBe(1);
    expect(recalibrated.total_processed).toBe(2);
  });

  it("rejects malformed JSONL without overwriting existing counters", async () => {
    const dataDir = await makeTempDataDir();
    const checkpoint = new CheckpointManager(dataDir);

    await checkpoint.write({
      last_captured_timestamp: 0,
      total_processed: 0,
      last_persona_at: 0,
      last_persona_time: "",
      request_persona_update: false,
      persona_update_reason: "",
      memories_since_last_persona: 4,
      scenes_processed: 0,
      runner_states: {},
      pipeline_states: {},
      l0_conversations_count: 7,
      total_memories_extracted: 9,
    });
    await fs.writeFile(path.join(dataDir, "records", "2026-07-01.jsonl"), "{not json}\n", "utf-8");

    await expect(checkpoint.recalibrate()).rejects.toThrow("Malformed JSONL");
    const cp = await checkpoint.read();
    expect(cp.l0_conversations_count).toBe(7);
    expect(cp.total_memories_extracted).toBe(9);
    expect(cp.memories_since_last_persona).toBe(4);
  });
});
