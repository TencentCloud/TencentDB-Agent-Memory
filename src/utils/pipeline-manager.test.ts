import { describe, expect, it } from "vitest";
import { MemoryPipelineManager } from "./pipeline-manager.js";
import type { CapturedMessage, PipelineConfig } from "./pipeline-manager.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const config: PipelineConfig = {
  everyNConversations: 5,
  enableWarmup: false,
  l1: { idleTimeoutSeconds: 3600 },
  l2: {
    delayAfterL1Seconds: 3600,
    minIntervalSeconds: 0,
    maxIntervalSeconds: 3600,
    sessionActiveWindowHours: 24,
  },
};

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("MemoryPipelineManager", () => {
  it("flushSession drains below-threshold buffered L1 work", async () => {
    const scheduler = new MemoryPipelineManager(config, logger);
    const seen: CapturedMessage[][] = [];

    scheduler.setL1Runner(async ({ msg }) => {
      seen.push(msg);
      return { processedCount: msg.length };
    });

    await scheduler.notifyConversation("seed-session", [{
      role: "user",
      content: "The final deliverable is the full crawled dataset.",
      timestamp: "2026-05-18T00:00:00.000Z",
    }]);

    expect(seen).toHaveLength(0);
    expect(scheduler.getSessionState("seed-session")?.conversation_count).toBe(1);
    expect(scheduler.getBufferedMessageCount("seed-session")).toBe(1);

    await scheduler.flushSession("seed-session");

    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(1);
    expect(scheduler.getSessionState("seed-session")?.conversation_count).toBe(0);
    expect(scheduler.getSessionState("seed-session")?.l2_pending_l1_count).toBe(1);
    expect(scheduler.getBufferedMessageCount("seed-session")).toBe(0);

    await scheduler.destroy();
  });

  it("flushSession drains DB-backed work when the in-memory buffer is empty", async () => {
    const scheduler = new MemoryPipelineManager(config, logger);
    let runs = 0;

    scheduler.setL1Runner(async ({ msg }) => {
      runs += 1;
      return { processedCount: msg.length };
    });

    await scheduler.notifyConversation("seed-db-session", []);

    expect(scheduler.getSessionState("seed-db-session")?.conversation_count).toBe(1);
    expect(scheduler.getBufferedMessageCount("seed-db-session")).toBe(0);

    await scheduler.flushSession("seed-db-session");

    expect(runs).toBe(1);
    expect(scheduler.getSessionState("seed-db-session")?.conversation_count).toBe(0);

    await scheduler.destroy();
  });

  it("flushSession waits for DB-backed work even when timers were evicted", async () => {
    const scheduler = new MemoryPipelineManager(config, logger);
    let completed = false;

    scheduler.setL1Runner(async () => {
      await delay(20);
      completed = true;
      return { processedCount: 1 };
    });

    await scheduler.notifyConversation("seed-restored-session", []);
    (scheduler as unknown as { sessionTimers: Map<string, unknown> }).sessionTimers.delete("seed-restored-session");

    await scheduler.flushSession("seed-restored-session");

    expect(completed).toBe(true);
    expect(scheduler.getSessionState("seed-restored-session")?.conversation_count).toBe(0);

    await scheduler.destroy();
  });

  it("can run L1 work for multiple sessions concurrently", async () => {
    const scheduler = new MemoryPipelineManager({
      ...config,
      l1: { idleTimeoutSeconds: 3600, concurrency: 2 },
    }, logger);
    let running = 0;
    let maxRunning = 0;

    scheduler.setL1Runner(async ({ msg }) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await delay(10);
      running -= 1;
      return { processedCount: msg.length };
    });

    await scheduler.notifyConversation("seed-session-a", [{
      role: "user",
      content: "Session A needs to be extracted.",
      timestamp: "2026-05-18T00:00:00.000Z",
    }]);
    await scheduler.notifyConversation("seed-session-b", [{
      role: "user",
      content: "Session B needs to be extracted.",
      timestamp: "2026-05-18T00:00:01.000Z",
    }]);

    await Promise.all([
      scheduler.flushSession("seed-session-a"),
      scheduler.flushSession("seed-session-b"),
    ]);

    expect(maxRunning).toBe(2);
    expect(scheduler.getBufferedMessageCount("seed-session-a")).toBe(0);
    expect(scheduler.getBufferedMessageCount("seed-session-b")).toBe(0);

    await scheduler.destroy();
  });

  it("flushSession waits for the target session instead of global L1 idle", async () => {
    const scheduler = new MemoryPipelineManager({
      ...config,
      l1: { idleTimeoutSeconds: 3600, concurrency: 2 },
    }, logger);

    scheduler.setL1Runner(async ({ sessionKey }) => {
      if (sessionKey === "seed-session-a") {
        await delay(80);
      }
      return { processedCount: 1 };
    });

    await scheduler.notifyConversation("seed-session-a", [{
      role: "user",
      content: "Session A is deliberately slow.",
      timestamp: "2026-05-18T00:00:00.000Z",
    }]);
    const slowFlush = scheduler.flushSession("seed-session-a");
    await delay(5);

    await scheduler.notifyConversation("seed-session-b", [{
      role: "user",
      content: "Session B should not wait for session A after its own L1 completes.",
      timestamp: "2026-05-18T00:00:01.000Z",
    }]);

    const start = Date.now();
    await scheduler.flushSession("seed-session-b");
    expect(Date.now() - start).toBeLessThan(70);

    await slowFlush;
    await scheduler.destroy();
  });
});
