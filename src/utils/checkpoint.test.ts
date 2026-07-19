import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CheckpointManager } from "./checkpoint.js";

describe("CheckpointManager.recalibrate", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-recalibrate-"));
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("replaces drifted counters with JSONL L1 and store L0 counts", async () => {
    const manager = new CheckpointManager(dataDir);
    const checkpoint = await manager.read();
    checkpoint.total_memories_extracted = 50;
    checkpoint.l0_conversations_count = 45;
    checkpoint.scenes_processed = 7;
    await manager.write(checkpoint);

    await writeJsonl("records/2026-07-05.jsonl", [{ id: "m1" }, { id: "m2" }]);
    await writeJsonl("records/2026-07-06.jsonl", [{ id: "m3" }]);

    const countL0 = vi.fn().mockResolvedValue(4);
    await manager.recalibrate({ vectorStore: { countL0 } });

    const recalibrated = await manager.read();
    expect(recalibrated.total_memories_extracted).toBe(3);
    expect(recalibrated.l0_conversations_count).toBe(4);
    expect(recalibrated.scenes_processed).toBe(7);
    expect(countL0).toHaveBeenCalledOnce();
  });

  it("falls back to L0 JSONL when the store count is unavailable", async () => {
    const warnings: string[] = [];
    const manager = new CheckpointManager(dataDir, {
      info() {},
      warn: (message) => warnings.push(message),
    });

    await writeJsonl("records/2026-07-06.jsonl", [{ id: "m1" }]);
    await writeJsonl("conversations/2026-07-06.jsonl", [
      { id: "l0-1" },
      { id: "l0-2" },
    ]);

    await manager.recalibrate({
      vectorStore: { countL0: vi.fn().mockRejectedValue(new Error("store offline")) },
    });

    const recalibrated = await manager.read();
    expect(recalibrated.total_memories_extracted).toBe(1);
    expect(recalibrated.l0_conversations_count).toBe(2);
    expect(warnings.some((message) => message.includes("store offline"))).toBe(true);
  });

  it("sets both counters to zero when no data exists", async () => {
    const manager = new CheckpointManager(dataDir);
    const checkpoint = await manager.read();
    checkpoint.total_memories_extracted = 12;
    checkpoint.l0_conversations_count = 8;
    await manager.write(checkpoint);

    await manager.recalibrate();

    const recalibrated = await manager.read();
    expect(recalibrated.total_memories_extracted).toBe(0);
    expect(recalibrated.l0_conversations_count).toBe(0);
  });

  it("preserves a counter when its source cannot be read", async () => {
    const warnings: string[] = [];
    const manager = new CheckpointManager(dataDir, {
      info() {},
      warn: (message) => warnings.push(message),
    });
    const checkpoint = await manager.read();
    checkpoint.total_memories_extracted = 12;
    await manager.write(checkpoint);

    // A file at the expected directory path forces readdir() to fail with ENOTDIR.
    await fs.writeFile(path.join(dataDir, "records"), "not a directory", "utf-8");
    await manager.recalibrate();

    const recalibrated = await manager.read();
    expect(recalibrated.total_memories_extracted).toBe(12);
    expect(warnings.some((message) => message.includes("preserving checkpoint value"))).toBe(true);
  });

  async function writeJsonl(relativePath: string, records: unknown[]): Promise<void> {
    const filePath = path.join(dataDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf-8");
  }
});
