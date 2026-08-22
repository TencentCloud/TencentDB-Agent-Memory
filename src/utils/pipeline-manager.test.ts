import { describe, expect, it } from "vitest";
import { MemoryPipelineManager } from "./pipeline-manager.js";
import type { CapturedMessage, PipelineConfig } from "./pipeline-manager.js";

function makePipelineConfig(): PipelineConfig {
  return {
    everyNConversations: 1,
    enableWarmup: false,
    l1: {
      idleTimeoutSeconds: 60,
    },
    l2: {
      delayAfterL1Seconds: 3_600,
      minIntervalSeconds: 0,
      maxIntervalSeconds: 3_600,
      sessionActiveWindowHours: 24,
    },
  };
}

function makeMessage(): CapturedMessage {
  return {
    role: "user",
    content: "remember this shutdown flush event",
    timestamp: "2026-06-30T00:00:00.000Z",
  };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("MemoryPipelineManager", () => {
  it("drains L1 shutdown work through L2 and L3 before marking the pipeline destroyed", async () => {
    const manager = new MemoryPipelineManager(makePipelineConfig());

    let releaseL1!: () => void;
    const l1Started = new Promise<void>((resolve) => {
      manager.setL1Runner(async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseL1 = release;
        });
      });
    });

    let l2Runs = 0;
    let l3Runs = 0;
    manager.setL2Runner(async () => {
      l2Runs += 1;
      return { latestCursor: "2026-06-30T00:00:01.000Z" };
    });
    manager.setL3Runner(async () => {
      l3Runs += 1;
    });

    await manager.notifyConversation("agent:main:user-1", [makeMessage()]);
    await l1Started;

    const destroyPromise = manager.destroy();
    releaseL1();
    await destroyPromise;

    expect(l2Runs).toBe(1);
    expect(l3Runs).toBe(1);
    expect(manager.isDestroyed).toBe(true);
  });

  it("waits for L3 work enqueued by the L2 shutdown flush", async () => {
    const manager = new MemoryPipelineManager(makePipelineConfig());

    manager.setL1Runner(async () => {});
    manager.setL2Runner(async () => ({ latestCursor: "2026-06-30T00:00:01.000Z" }));

    let releaseL3!: () => void;
    const l3Started = new Promise<void>((resolve) => {
      manager.setL3Runner(async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseL3 = release;
        });
      });
    });

    await manager.notifyConversation("agent:main:user-1", [makeMessage()]);

    const destroyPromise = manager.destroy();
    let destroySettled = false;
    const observedDestroy = destroyPromise.then(() => {
      destroySettled = true;
    });

    await l3Started;
    await nextTick();

    expect(destroySettled).toBe(false);

    releaseL3();
    await observedDestroy;

    expect(manager.isDestroyed).toBe(true);
  });
});
