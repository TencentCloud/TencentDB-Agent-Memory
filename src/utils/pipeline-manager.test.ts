import { describe, it, expect } from "vitest";
import { MemoryPipelineManager } from "./pipeline-manager.js";
import type { L1Runner } from "./pipeline-manager.js";

const baseConfig = {
  everyNConversations: 5,
  enableWarmup: false,
  l1: {
    idleTimeoutSeconds: 600,
  },
  l2: {
    delayAfterL1Seconds: 600,
    minIntervalSeconds: 900,
    maxIntervalSeconds: 3600,
    sessionActiveWindowHours: 24,
  },
};

describe("MemoryPipelineManager", () => {
  it("flushSession flushes DB-backed pending conversations even when the message buffer is empty", async () => {
    const scheduler = new MemoryPipelineManager(baseConfig);
    const calls: Parameters<L1Runner>[0][] = [];

    scheduler.setL1Runner(async (params) => {
      calls.push(params);
      return { processedCount: 0 };
    });

    try {
      await scheduler.notifyConversation("seed-session", []);

      expect(scheduler.getBufferedMessageCount("seed-session")).toBe(0);
      expect(scheduler.getSessionState("seed-session")?.conversation_count).toBe(1);

      await scheduler.flushSession("seed-session");

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        sessionKey: "seed-session",
        msg: [],
        bg_msg: [],
      });
      expect(scheduler.getSessionState("seed-session")?.conversation_count).toBe(0);
      expect(scheduler.getSessionState("seed-session")?.l2_pending_l1_count).toBe(1);
    } finally {
      await scheduler.destroy();
    }
  });
});
