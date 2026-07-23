import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IMemoryStore } from "../core/store/types.js";
import { CheckpointManager } from "./checkpoint.js";
import { LocalMemoryCleaner } from "./memory-cleaner.js";

describe("LocalMemoryCleaner checkpoint reconciliation", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-cleaner-test-"));
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("recalibrates checkpoint counters after automatic store cleanup", async () => {
    const checkpointManager = new CheckpointManager(dataDir);
    const checkpoint = await checkpointManager.read();
    checkpoint.total_processed = 60;
    checkpoint.l0_conversations_count = 60;
    checkpoint.total_memories_extracted = 30;
    checkpoint.memories_since_last_persona = 10;
    checkpoint.last_persona_at = 55;
    await checkpointManager.write(checkpoint);

    const countL0 = vi.fn()
      .mockResolvedValueOnce(60)
      .mockResolvedValueOnce(50);
    const countL1 = vi.fn()
      .mockResolvedValueOnce(30)
      .mockResolvedValueOnce(25);
    const deleteL0Expired = vi.fn().mockResolvedValue(10);
    const deleteL1Expired = vi.fn().mockResolvedValue(5);
    const vectorStore = {
      isDegraded: () => false,
      countL0,
      countL1,
      deleteL0Expired,
      deleteL1Expired,
    } as unknown as IMemoryStore;

    const cleaner = new LocalMemoryCleaner({
      baseDir: dataDir,
      retentionDays: 2,
      cleanTime: "03:00",
      vectorStore,
    });

    await cleaner.runOnce(Date.UTC(2026, 6, 24, 12));

    expect(deleteL0Expired).toHaveBeenCalledOnce();
    expect(deleteL1Expired).toHaveBeenCalledOnce();
    expect(countL0).toHaveBeenCalledTimes(2);
    expect(countL1).toHaveBeenCalledTimes(2);

    const recalibrated = await checkpointManager.read();
    expect(recalibrated.total_processed).toBe(50);
    expect(recalibrated.l0_conversations_count).toBe(50);
    expect(recalibrated.total_memories_extracted).toBe(25);
    expect(recalibrated.memories_since_last_persona).toBe(5);
    expect(recalibrated.last_persona_at).toBe(55);
  });
});
