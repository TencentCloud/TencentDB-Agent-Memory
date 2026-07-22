import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CheckpointManager, type CheckpointCountSource } from "./checkpoint.js";

describe("CheckpointManager recalibration", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "tdai-checkpoint-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  const source = (l0: number, l1: number): CheckpointCountSource => ({
    countL0: vi.fn((options?: { strict?: boolean }) => {
      expect(options).toEqual({ strict: true });
      return l0;
    }),
    countL1: vi.fn((options?: { strict?: boolean }) => {
      expect(options).toEqual({ strict: true });
      return l1;
    }),
  });

  async function seed(manager: CheckpointManager): Promise<void> {
    await manager.captureAtomically("session-a", undefined, async () => ({
      maxTimestamp: 100,
      messageCount: 5,
    }));
    await manager.markL1ExtractionComplete("session-a", 10, 90, "scene-a");
    await manager.setPersonaUpdateRequest("keep-me");
    await manager.incrementScenesProcessed();
  }

  it("repairs downward drift while preserving unrelated checkpoint state", async () => {
    const manager = new CheckpointManager(dataDir);
    await seed(manager);

    const result = await manager.recalibrate(source(2, 3));
    const checkpoint = await manager.read();

    expect(result).toEqual({
      l0: { before: 5, observed: 2, after: 2 },
      l1: { before: 10, observed: 3, after: 3 },
      changed: true,
    });
    expect(checkpoint.l0_conversations_count).toBe(2);
    expect(checkpoint.total_memories_extracted).toBe(3);
    expect(checkpoint.total_processed).toBe(5);
    expect(checkpoint.request_persona_update).toBe(true);
    expect(checkpoint.persona_update_reason).toBe("keep-me");
    expect(checkpoint.scenes_processed).toBe(1);
    expect(checkpoint.runner_states["session-a"]?.last_scene_name).toBe("scene-a");
  });

  it("applies a legitimate empty-store count and is idempotent", async () => {
    const manager = new CheckpointManager(dataDir);
    await seed(manager);

    const first = await manager.recalibrate(source(0, 0));
    const second = await manager.recalibrate(source(0, 0));
    const checkpoint = await manager.read();

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(checkpoint.l0_conversations_count).toBe(0);
    expect(checkpoint.total_memories_extracted).toBe(0);
  });

  it.each([Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid store count %s without changing the checkpoint",
    async (invalidCount) => {
      const manager = new CheckpointManager(dataDir);
      await seed(manager);
      const before = await manager.read();

      await expect(manager.recalibrate(source(invalidCount, 3))).rejects.toThrow(
        "Invalid L0 count from store",
      );

      expect(await manager.read()).toEqual(before);
    },
  );

  it("leaves the checkpoint unchanged when a strict store count fails", async () => {
    const manager = new CheckpointManager(dataDir);
    await seed(manager);
    const before = await manager.read();
    const failingSource: CheckpointCountSource = {
      countL0: () => {
        throw new Error("store unavailable");
      },
      countL1: () => 3,
    };

    await expect(manager.recalibrate(failingSource)).rejects.toThrow("store unavailable");
    expect(await manager.read()).toEqual(before);
  });

  it("serializes recalibration with capture so neither update is lost", async () => {
    const recalibrator = new CheckpointManager(dataDir);
    const capturer = new CheckpointManager(dataDir);
    let releaseCount!: () => void;
    let countStarted!: () => void;
    const countStartedPromise = new Promise<void>((resolve) => { countStarted = resolve; });
    const releaseCountPromise = new Promise<void>((resolve) => { releaseCount = resolve; });

    const recalibration = recalibrator.recalibrate({
      countL0: async () => {
        countStarted();
        await releaseCountPromise;
        return 4;
      },
      countL1: () => 0,
    });
    await countStartedPromise;

    const capture = capturer.captureAtomically("session-b", undefined, async () => ({
      maxTimestamp: 200,
      messageCount: 2,
    }));
    releaseCount();
    await Promise.all([recalibration, capture]);

    const checkpoint = await recalibrator.read();
    expect(checkpoint.l0_conversations_count).toBe(6);
    expect(checkpoint.total_processed).toBe(2);
  });
});
