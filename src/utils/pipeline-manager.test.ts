import { describe, expect, it } from "vitest";

import { MemoryPipelineManager } from "./pipeline-manager.js";

const config = {
  everyNConversations: 5,
  enableWarmup: false,
  l1: { idleTimeoutSeconds: 60 },
  l2: {
    delayAfterL1Seconds: 90,
    minIntervalSeconds: 300,
    maxIntervalSeconds: 1800,
    sessionActiveWindowHours: 24,
  },
};

describe("MemoryPipelineManager diagnostics", () => {
  it("reports per-session L0/L1 waiting state without mutating queues", async () => {
    const manager = new MemoryPipelineManager(config);

    await manager.notifyConversation("session-a", [
      { role: "user", content: "remember I prefer Chinese replies", timestamp: "2026-06-26T00:00:00.000Z" },
      { role: "assistant", content: "好的", timestamp: "2026-06-26T00:00:01.000Z" },
    ]);

    const diagnostic = manager.getSessionDiagnostics("session-a");

    expect(diagnostic.known).toBe(true);
    expect(diagnostic.sessionKey).toBe("session-a");
    expect(diagnostic.state?.conversation_count).toBe(1);
    expect(diagnostic.effectiveL1Threshold).toBe(5);
    expect(diagnostic.bufferedMessageCount).toBe(2);
    expect(diagnostic.timers.l1IdlePending).toBe(true);
    expect(diagnostic.timers.l2SchedulePending).toBe(false);
    expect(diagnostic.queues.l1Idle).toBe(true);

    await manager.destroy();
  });

  it("reports unknown sessions explicitly", () => {
    const manager = new MemoryPipelineManager(config);

    const diagnostic = manager.getSessionDiagnostics("missing-session");

    expect(diagnostic).toMatchObject({
      sessionKey: "missing-session",
      known: false,
      bufferedMessageCount: 0,
    });
    expect(diagnostic.state).toBeUndefined();
  });
});
