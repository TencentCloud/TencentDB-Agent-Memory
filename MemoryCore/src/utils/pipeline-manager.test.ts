import { describe, expect, it, vi } from "vitest";

import { MemoryPipelineManager, type PipelineConfig } from "./pipeline-manager.js";

const config: PipelineConfig = {
  everyNConversations: 1,
  enableWarmup: false,
  l1: { idleTimeoutSeconds: 60 },
  l2: {
    delayAfterL1Seconds: 60,
    minIntervalSeconds: 60,
    maxIntervalSeconds: 3600,
    sessionActiveWindowHours: 24,
  },
};

describe("MemoryPipelineManager", () => {
  it("drains the L3 cascade produced by a flushed L2 task", async () => {
    const l2Runs = vi.fn();
    const l3Runs = vi.fn();
    let releaseL3!: () => void;
    const l3Finished = new Promise<void>((resolve) => {
      releaseL3 = resolve;
    });
    const manager = new MemoryPipelineManager(config);

    manager.setL1Runner(async () => ({ processedCount: 1 }));
    manager.setL2Runner(async () => {
      l2Runs();
      return { latestCursor: "2026-08-19T00:00:00.000Z" };
    });
    manager.setL3Runner(async () => {
      l3Runs();
      await l3Finished;
    });

    await manager.notifyConversation("session-1", [{
      role: "user",
      content: "A captured message",
      timestamp: "2026-08-19T00:00:00.000Z",
    }]);

    await vi.waitFor(() => {
      expect(manager.getSessionState("session-1")?.l2_pending_l1_count).toBe(1);
    });
    expect(l2Runs).not.toHaveBeenCalled();
    expect(l3Runs).not.toHaveBeenCalled();

    let destroyFinished = false;
    const destroyPromise = manager.destroy().then(() => {
      destroyFinished = true;
    });

    await vi.waitFor(() => {
      expect(l3Runs).toHaveBeenCalledTimes(1);
    });
    expect(destroyFinished).toBe(false);

    releaseL3();
    await destroyPromise;

    expect(l2Runs).toHaveBeenCalledTimes(1);
    expect(l3Runs).toHaveBeenCalledTimes(1);
    expect(manager.getQueueSizes()).toMatchObject({
      l1Idle: true,
      l2Idle: true,
      l3Idle: true,
    });
  });
});
