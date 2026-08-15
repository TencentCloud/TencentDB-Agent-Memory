import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IMemoryStore } from "../core/store/types.js";
import { CheckpointManager } from "./checkpoint.js";

describe("CheckpointManager counter recalibration", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-test-"));
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("tracks L0 message records using the same unit as the backing store", async () => {
    const manager = new CheckpointManager(dataDir);

    await manager.captureAtomically("session-1", undefined, async () => ({
      maxTimestamp: 1_700_000_000_000,
      messageCount: 3,
    }));

    const checkpoint = await manager.read();
    expect(checkpoint.total_processed).toBe(3);
    expect(checkpoint.l0_conversations_count).toBe(3);
  });

  it("replaces drifted counters from the active store without changing session state", async () => {
    const manager = new CheckpointManager(dataDir);
    const checkpoint = await manager.read();
    checkpoint.total_processed = 8;
    checkpoint.l0_conversations_count = 8;
    checkpoint.total_memories_extracted = 5;
    checkpoint.memories_since_last_persona = 3;
    checkpoint.last_persona_at = 6;
    checkpoint.runner_states["session-1"] = {
      last_captured_timestamp: 123,
      last_l1_cursor: 456,
      last_scene_name: "scene",
    };
    await manager.write(checkpoint);

    const store = {
      isDegraded: () => false,
      countL0: vi.fn().mockResolvedValue(2),
      countL1: vi.fn().mockResolvedValue(3),
    } as unknown as IMemoryStore;

    await manager.recalibrate(store);

    const recalibrated = await manager.read();
    expect(recalibrated.total_processed).toBe(2);
    expect(recalibrated.l0_conversations_count).toBe(2);
    expect(recalibrated.total_memories_extracted).toBe(3);
    expect(recalibrated.memories_since_last_persona).toBe(1);
    expect(recalibrated.last_persona_at).toBe(6);
    expect(recalibrated.runner_states["session-1"]).toEqual(
      checkpoint.runner_states["session-1"],
    );
  });

  it("recounts valid JSONL records after manual pruning and a full reset", async () => {
    const manager = new CheckpointManager(dataDir);
    const checkpoint = await manager.read();
    checkpoint.total_processed = 20;
    checkpoint.l0_conversations_count = 20;
    checkpoint.total_memories_extracted = 10;
    checkpoint.memories_since_last_persona = 7;
    await manager.write(checkpoint);

    const conversationsDir = path.join(dataDir, "conversations");
    const recordsDir = path.join(dataDir, "records");
    await fs.mkdir(conversationsDir, { recursive: true });
    await fs.mkdir(recordsDir, { recursive: true });
    await fs.writeFile(
      path.join(conversationsDir, "2026-07-24.jsonl"),
      [
        JSON.stringify({ role: "user", content: "first" }),
        "{malformed",
        JSON.stringify({ role: "assistant", content: "second" }),
        "",
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(recordsDir, "2026-07-24.jsonl"),
      `${JSON.stringify({ id: "memory-1", content: "remember this" })}\n{malformed\n`,
      "utf-8",
    );

    await manager.recalibrate();

    let recalibrated = await manager.read();
    expect(recalibrated.total_processed).toBe(2);
    expect(recalibrated.l0_conversations_count).toBe(2);
    expect(recalibrated.total_memories_extracted).toBe(1);
    expect(recalibrated.memories_since_last_persona).toBe(0);

    await fs.rm(conversationsDir, { recursive: true });
    await fs.rm(recordsDir, { recursive: true });
    await manager.recalibrate();

    recalibrated = await manager.read();
    expect(recalibrated.total_processed).toBe(0);
    expect(recalibrated.l0_conversations_count).toBe(0);
    expect(recalibrated.total_memories_extracted).toBe(0);
    expect(recalibrated.memories_since_last_persona).toBe(0);
  });
});
