import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CheckpointManager } from "./checkpoint.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-persona-race-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("CheckpointManager persona generation coverage", () => {
  it("preserves memories extracted while persona generation is running", async () => {
    const checkpoint = new CheckpointManager(await makeTempDir());
    const sceneUpdatedThrough = "2026-07-12T01:00:00.000Z";

    await checkpoint.captureAtomically("before", undefined, async () => ({
      maxTimestamp: 100,
      messageCount: 3,
    }));
    await checkpoint.markL1ExtractionComplete("before", 3);
    const baseline = await checkpoint.read();

    await checkpoint.captureAtomically("during", undefined, async () => ({
      maxTimestamp: 200,
      messageCount: 2,
    }));
    await checkpoint.markL1ExtractionComplete("during", 2);

    await checkpoint.markPersonaGenerated(baseline.total_processed, {
      memoriesSinceLastPersona: baseline.memories_since_last_persona,
      sceneUpdatedThrough,
    });

    const current = await checkpoint.read();
    expect(current.total_processed).toBe(5);
    expect(current.last_persona_at).toBe(3);
    expect(current.last_persona_time).toBe(sceneUpdatedThrough);
    expect(current.total_memories_extracted).toBe(5);
    expect(current.memories_since_last_persona).toBe(2);
  });

  it("consumes the full baseline when no new memories arrive", async () => {
    const checkpoint = new CheckpointManager(await makeTempDir());
    await checkpoint.markL1ExtractionComplete("session", 4);
    const baseline = await checkpoint.read();

    await checkpoint.markPersonaGenerated(baseline.total_processed, {
      memoriesSinceLastPersona: baseline.memories_since_last_persona,
      sceneUpdatedThrough: "2026-07-12T01:00:00.000Z",
    });

    expect((await checkpoint.read()).memories_since_last_persona).toBe(0);
  });

  it("keeps the legacy clear-all behavior when coverage is omitted", async () => {
    const checkpoint = new CheckpointManager(await makeTempDir());
    await checkpoint.markL1ExtractionComplete("session", 4);

    await checkpoint.markPersonaGenerated(0);

    expect((await checkpoint.read()).memories_since_last_persona).toBe(0);
  });

  it("clamps the remaining counter when cleanup shrinks it below the baseline", async () => {
    const checkpoint = new CheckpointManager(await makeTempDir());
    await checkpoint.markL1ExtractionComplete("session", 2);

    await checkpoint.markPersonaGenerated(0, {
      memoriesSinceLastPersona: 5,
      sceneUpdatedThrough: "2026-07-12T01:00:00.000Z",
    });

    expect((await checkpoint.read()).memories_since_last_persona).toBe(0);
  });
});
