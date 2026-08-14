import { describe, expect, it } from "vitest";
import { MemoryPipelineManager } from "../pipeline-manager.js";

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

describe("pipeline shutdown", () => {
  it("re-enters L1 for a conversation left pending across restart", async () => {
    const manager = new MemoryPipelineManager(
      {
        everyNConversations: 1,
        enableWarmup: false,
        l1: { idleTimeoutSeconds: 60 },
        l2: {
          delayAfterL1Seconds: 3_600,
          minIntervalSeconds: 3_600,
          maxIntervalSeconds: 7_200,
          sessionActiveWindowHours: 24,
        },
      },
      logger,
    );
    let l1Runs = 0;
    let l2Runs = 0;
    manager.setL1Runner(async () => {
      l1Runs += 1;
      return { processedCount: 1 };
    });
    manager.setL2Runner(async () => {
      l2Runs += 1;
    });
    manager.setPersister(async () => undefined);
    manager.start({
      recovered: {
        conversation_count: 1,
        last_extraction_time: "",
        last_extraction_updated_time: "",
        last_active_time: Date.now(),
        l2_pending_l1_count: 0,
        warmup_threshold: 0,
        l2_last_extraction_time: "",
      },
    });

    await manager.flushSession("recovered");

    expect(l1Runs).toBe(1);
    expect(l2Runs).toBe(0);
  });

  it("preserves scheduled L2 instead of starting it during store teardown", async () => {
    const manager = new MemoryPipelineManager(
      {
        everyNConversations: 1,
        enableWarmup: false,
        l1: { idleTimeoutSeconds: 60 },
        l2: {
          delayAfterL1Seconds: 3_600,
          minIntervalSeconds: 3_600,
          maxIntervalSeconds: 7_200,
          sessionActiveWindowHours: 24,
        },
      },
      logger,
    );
    let l2Runs = 0;
    manager.setL1Runner(async () => ({ processedCount: 1 }));
    manager.setL2Runner(async () => {
      l2Runs += 1;
    });
    manager.setPersister(async () => undefined);
    manager.start();

    await manager.notifyConversation("session", [
      { role: "user", content: "durable preference" },
    ]);
    await manager.flushSession("session");
    expect(manager.sessionTimers.get("session")?.l2Schedule.pending).toBe(true);

    await manager.destroy();

    expect(l2Runs).toBe(0);
    expect(manager.getSessionState("session")?.l2_pending_l1_count).toBe(1);
  });
});
