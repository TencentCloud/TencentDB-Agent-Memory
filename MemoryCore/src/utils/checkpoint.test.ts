import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckpointManager } from "./checkpoint.js";

describe("CheckpointManager persona counters", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("increments the persona counter without requiring a global L1 cursor", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "tdai-checkpoint-"));
    tempDirs.push(dataDir);
    const logger = { info: vi.fn() };
    const checkpoint = new CheckpointManager(dataDir, logger);

    await checkpoint.incrementMemoriesSinceLastPersona(3);

    await expect(checkpoint.read()).resolves.toMatchObject({
      memories_since_last_persona: 3,
      total_memories_extracted: 0,
    });
  });

  it("can update the L1 cursor while leaving the global persona counter untouched", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "tdai-checkpoint-"));
    tempDirs.push(dataDir);
    const checkpoint = new CheckpointManager(dataDir, { info: vi.fn() });

    await checkpoint.markL1ExtractionComplete(
      "session-1",
      4,
      123,
      undefined,
      { countForPersona: false },
    );

    await expect(checkpoint.read()).resolves.toMatchObject({
      memories_since_last_persona: 0,
      total_memories_extracted: 4,
      runner_states: { "session-1": { last_l1_cursor: 123 } },
    });
  });
});
