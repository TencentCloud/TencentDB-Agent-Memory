import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryPipelineManager, type CapturedMessage, type PipelineConfig } from "./pipeline-manager.js";

const config: PipelineConfig = {
  everyNConversations: 1,
  enableWarmup: false,
  l1: {
    idleTimeoutSeconds: 60,
  },
  l2: {
    delayAfterL1Seconds: 1,
    minIntervalSeconds: 5,
    maxIntervalSeconds: 10,
    sessionActiveWindowHours: 24,
  },
};

function message(content: string): CapturedMessage {
  return {
    role: "user",
    content,
    timestamp: new Date().toISOString(),
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("MemoryPipelineManager", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops idle L2 maxInterval polling after the cold-start retry also skips", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T00:00:00.000Z"));

    const manager = new MemoryPipelineManager(config);
    const l1Runner = vi.fn().mockResolvedValue(undefined);
    const l2Runner = vi.fn().mockResolvedValue({ skipped: true });

    manager.setL1Runner(l1Runner);
    manager.setL2Runner(l2Runner);

    await manager.notifyConversation("session-a", [message("first")]);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(l1Runner).toHaveBeenCalledTimes(1);
    expect(l2Runner).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();

    expect(l2Runner).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    expect(l2Runner).toHaveBeenCalledTimes(2);

    l2Runner.mockResolvedValueOnce({ skipped: true });
    await manager.notifyConversation("session-a", [message("second")]);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(l1Runner).toHaveBeenCalledTimes(2);
    expect(l2Runner).toHaveBeenCalledTimes(3);

    await manager.destroy();
  });

  it("keeps maxInterval polling after L2 has established a cursor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T00:00:00.000Z"));

    const manager = new MemoryPipelineManager(config);
    const l1Runner = vi.fn().mockResolvedValue(undefined);
    const l2Runner = vi.fn()
      .mockResolvedValueOnce({ latestCursor: "2026-06-11T00:00:01.000Z" })
      .mockResolvedValue({ skipped: true });

    manager.setL1Runner(l1Runner);
    manager.setL2Runner(l2Runner);

    await manager.notifyConversation("session-b", [message("first")]);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(l2Runner).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();

    expect(l2Runner).toHaveBeenCalledTimes(2);

    await manager.destroy();
  });
});
