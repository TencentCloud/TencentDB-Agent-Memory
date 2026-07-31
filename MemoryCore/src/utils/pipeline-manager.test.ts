import { describe, expect, it, vi } from "vitest";
import {
  MemoryPipelineManager,
  type CapturedMessage,
  type PipelineConfig,
} from "./pipeline-manager.js";

const config: PipelineConfig = {
  everyNConversations: 1,
  enableWarmup: false,
  l1: {
    idleTimeoutSeconds: 60,
  },
  l2: {
    delayAfterL1Seconds: 3_600,
    minIntervalSeconds: 3_600,
    maxIntervalSeconds: 3_600,
    sessionActiveWindowHours: 24,
  },
};

const message: CapturedMessage = {
  role: "user",
  content: "Project Atlas has a deployment freeze until Friday.",
  timestamp: "2026-07-31T00:00:00.000Z",
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("MemoryPipelineManager.flushAll", () => {
  it("waits for L2 and the L3 work enqueued by L2 before returning", async () => {
    const manager = new MemoryPipelineManager(config);
    const l2Gate = deferred();
    const l3Gate = deferred();

    manager.setL1Runner(vi.fn().mockResolvedValue({ processedCount: 1 }));
    const l2Runner = vi.fn(async () => {
      await l2Gate.promise;
      return { latestCursor: "2026-07-31T00:00:01.000Z" };
    });
    const l3Runner = vi.fn(async () => {
      await l3Gate.promise;
    });
    manager.setL2Runner(l2Runner);
    manager.setL3Runner(l3Runner);

    await manager.notifyConversation("seed-session", [message]);

    let flushCompleted = false;
    const flushPromise = manager.flushAll().then(() => {
      flushCompleted = true;
    });

    await vi.waitFor(() => expect(l2Runner).toHaveBeenCalledTimes(1));
    expect(flushCompleted).toBe(false);

    l2Gate.resolve();
    await vi.waitFor(() => expect(l3Runner).toHaveBeenCalledTimes(1));
    expect(flushCompleted).toBe(false);

    l3Gate.resolve();
    await flushPromise;

    expect(flushCompleted).toBe(true);
    expect(manager.getQueueSizes()).toMatchObject({
      l1Idle: true,
      l2Idle: true,
      l3Idle: true,
    });

    await manager.destroy();
    expect(l2Runner).toHaveBeenCalledTimes(1);
    expect(l3Runner).toHaveBeenCalledTimes(1);
  });
});
