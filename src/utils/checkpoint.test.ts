import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IMemoryStore } from "../core/store/types.js";
import { CheckpointManager } from "./checkpoint.js";

describe("CheckpointManager", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("recalibrates derived counters from persisted L0 and L1 JSONL data", async () => {
    await fs.mkdir(path.join(tempDir, "conversations"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "records"), { recursive: true });

    await fs.writeFile(
      path.join(tempDir, "conversations", "2026-07-09.jsonl"),
      [
        JSON.stringify({ sessionKey: "s1", role: "user", content: "hello" }),
        JSON.stringify({ sessionKey: "s1", role: "assistant", content: "hi" }),
        "not-json",
        "",
      ].join("\n"),
      "utf-8",
    );

    await fs.writeFile(
      path.join(tempDir, "records", "2026-07-09.jsonl"),
      [
        JSON.stringify({
          id: "m1",
          content: "old memory",
          createdAt: "2026-07-08T00:00:00.000Z",
          updatedAt: "2026-07-08T00:00:00.000Z",
        }),
        JSON.stringify({
          id: "m2",
          content: "new memory",
          createdAt: "2026-07-09T10:00:00.000Z",
          updatedAt: "2026-07-09T10:00:00.000Z",
        }),
        JSON.stringify({
          id: "m3",
          content: "newer memory",
          createdAt: "2026-07-09T11:00:00.000Z",
          updatedAt: "2026-07-09T11:00:00.000Z",
        }),
      ].join("\n"),
      "utf-8",
    );

    const checkpoint = new CheckpointManager(tempDir);
    const stale = await checkpoint.read();
    await checkpoint.write({
      ...stale,
      total_processed: 0,
      l0_conversations_count: 0,
      total_memories_extracted: 1,
      memories_since_last_persona: 0,
      last_persona_time: "2026-07-09T09:00:00.000Z",
      request_persona_update: true,
      persona_update_reason: "manual",
      runner_states: {
        s1: {
          last_captured_timestamp: 100,
          last_l1_cursor: 200,
          last_scene_name: "Existing Scene",
        },
      },
    });

    const result = await checkpoint.recalibrate();
    const repaired = await checkpoint.read();

    expect(result).toEqual({
      total_processed: 2,
      l0_conversations_count: 2,
      total_memories_extracted: 3,
      memories_since_last_persona: 2,
    });
    expect(repaired.total_processed).toBe(2);
    expect(repaired.l0_conversations_count).toBe(2);
    expect(repaired.total_memories_extracted).toBe(3);
    expect(repaired.memories_since_last_persona).toBe(2);
    expect(repaired.request_persona_update).toBe(true);
    expect(repaired.persona_update_reason).toBe("manual");
    expect(repaired.runner_states.s1?.last_scene_name).toBe("Existing Scene");
  });

  it("counts all L1 records as since-persona when no persona cursor exists", async () => {
    await fs.mkdir(path.join(tempDir, "records"), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, "records", "2026-07-09.jsonl"),
      [
        JSON.stringify({ id: "m1", content: "first" }),
        JSON.stringify({ id: "m2", content: "second" }),
      ].join("\n"),
      "utf-8",
    );

    const checkpoint = new CheckpointManager(tempDir);

    await expect(checkpoint.recalibrate()).resolves.toMatchObject({
      total_memories_extracted: 2,
      memories_since_last_persona: 2,
    });
  });

  it("uses current vector store counts when a store is available", async () => {
    const vectorStore = {
      isDegraded: () => false,
      countL0: () => 4,
      countL1: () => 3,
      queryL1Records: () => [
        {
          record_id: "m3",
          content: "after persona",
          type: "persona",
          priority: 10,
          scene_name: "Scene",
          session_key: "s1",
          session_id: "",
          timestamp_str: "",
          timestamp_start: "",
          timestamp_end: "",
          created_time: "2026-07-09T10:00:00.000Z",
          updated_time: "2026-07-09T10:00:00.000Z",
          metadata_json: "{}",
        },
      ],
    } as Partial<IMemoryStore> as IMemoryStore;

    const checkpoint = new CheckpointManager(tempDir);
    const overReported = await checkpoint.read();
    await checkpoint.write({
      ...overReported,
      total_processed: 10,
      l0_conversations_count: 10,
      total_memories_extracted: 8,
      memories_since_last_persona: 8,
      last_persona_time: "2026-07-09T09:00:00.000Z",
    });

    const result = await checkpoint.recalibrate(vectorStore);
    const repaired = await checkpoint.read();

    expect(result).toEqual({
      total_processed: 4,
      l0_conversations_count: 4,
      total_memories_extracted: 3,
      memories_since_last_persona: 1,
    });
    expect(repaired.total_processed).toBe(4);
    expect(repaired.total_memories_extracted).toBe(3);
    expect(repaired.memories_since_last_persona).toBe(1);
  });
});
