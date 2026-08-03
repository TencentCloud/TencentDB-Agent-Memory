import { afterEach, describe, expect, it, vi } from "vitest";

import type { CodeGraphService } from "./code-graph-service.js";
import type { IKnowledgeStore } from "./types.js";

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => logger,
}));

import { AutoSyncScheduler } from "./auto-sync-scheduler.js";

function createScheduler(maxConcurrentSyncs = 2): AutoSyncScheduler {
  const store = {
    listSyncedCodeGraphs: vi.fn(() => []),
  } as unknown as IKnowledgeStore;
  const cgService = {
    sync: vi.fn(),
  } as unknown as CodeGraphService;
  return new AutoSyncScheduler({
    store,
    cgService,
    config: {
      enabled: true,
      scanIntervalMs: 60_000,
      maxConcurrentSyncs,
    },
  });
}

function workerCount(scheduler: AutoSyncScheduler): number {
  return (scheduler as unknown as { workerCount: number }).workerCount;
}

async function settleWorkers(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("AutoSyncScheduler worker lifecycle", () => {
  it("wakes sleeping workers on stop", async () => {
    vi.useFakeTimers();
    const scheduler = createScheduler();

    scheduler.start();
    expect(workerCount(scheduler)).toBe(2);

    scheduler.stop();
    await settleWorkers();

    expect(workerCount(scheduler)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not revive stopped workers during an immediate restart", async () => {
    vi.useFakeTimers();
    const scheduler = createScheduler();

    scheduler.start();
    scheduler.stop();
    scheduler.start();
    await settleWorkers();

    expect(workerCount(scheduler)).toBe(2);

    scheduler.stop();
    await settleWorkers();
    expect(workerCount(scheduler)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
