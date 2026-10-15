import { describe, it, expect } from "vitest";
import { MemoryPipelineManager } from "./pipeline-manager.js";
import type { PipelineConfig, CapturedMessage } from "./pipeline-manager.js";
import { AsyncSemaphore } from "./async-semaphore.js";

/**
 * Integration check for the cross-core extraction cap (design §8.4 #5).
 *
 * The structural multi-tenant route gives each account its OWN
 * MemoryPipelineManager, each with its own L1/L2/L3 SerialQueues — so without a
 * shared limiter, `N` accounts fan out to `N` concurrent L1 runs. These tests
 * stand up several managers (one per "account") sharing a single
 * {@link AsyncSemaphore} and assert the peak number of L1 runners executing at
 * once never exceeds the configured cap.
 */

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Minimal pipeline config: warm-up on → the first conversation triggers L1. */
function testPipelineConfig(): PipelineConfig {
  return {
    everyNConversations: 1,
    enableWarmup: true,
    l1: { idleTimeoutSeconds: 999 },
    l2: {
      delayAfterL1Seconds: 999,
      minIntervalSeconds: 999,
      maxIntervalSeconds: 999,
      sessionActiveWindowHours: 24,
    },
  };
}

const msg = (content: string): CapturedMessage => ({
  role: "user",
  content,
  timestamp: new Date(0).toISOString(),
});

/** Poll until every manager's L1 queue is idle (or time out). */
async function waitForL1Idle(managers: MemoryPipelineManager[], timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (managers.every((m) => m.getQueueSizes().l1Idle)) return;
    await delay(10);
  }
  throw new Error("timed out waiting for L1 queues to drain");
}

/**
 * Build `count` managers sharing `limiter`, each with an L1 runner that records
 * peak overlap into the shared `tracker`. Returns the managers + the tracker.
 */
function buildManagers(count: number, limiter: AsyncSemaphore | undefined, holdMs: number) {
  const tracker = { active: 0, peak: 0, runs: 0 };
  const managers = Array.from({ length: count }, () => {
    const mgr = new MemoryPipelineManager(testPipelineConfig(), undefined, undefined, limiter);
    mgr.setL1Runner(async () => {
      tracker.active++;
      tracker.runs++;
      tracker.peak = Math.max(tracker.peak, tracker.active);
      await delay(holdMs);
      tracker.active--;
      return { processedCount: 1 };
    });
    return mgr;
  });
  return { managers, tracker };
}

describe("MemoryPipelineManager — shared extraction limiter", () => {
  it("caps concurrent L1 across managers at the shared limit", async () => {
    const limiter = new AsyncSemaphore(1);
    const { managers, tracker } = buildManagers(4, limiter, 25);

    // Fire one conversation per manager (each triggers L1 immediately via warm-up).
    await Promise.all(managers.map((m, i) => m.notifyConversation(`acct-${i}`, [msg(`hi ${i}`)])));
    await waitForL1Idle(managers);

    expect(tracker.runs).toBe(4); // every account's L1 ran
    expect(tracker.peak).toBe(1); // but never more than one at a time

    await Promise.all(managers.map((m) => m.destroy()));
  });

  it("allows up to the cap to run together (cap = 2)", async () => {
    const limiter = new AsyncSemaphore(2);
    const { managers, tracker } = buildManagers(6, limiter, 25);

    await Promise.all(managers.map((m, i) => m.notifyConversation(`acct-${i}`, [msg(`hi ${i}`)])));
    await waitForL1Idle(managers);

    expect(tracker.runs).toBe(6);
    expect(tracker.peak).toBe(2);

    await Promise.all(managers.map((m) => m.destroy()));
  });

  it("without a shared limiter, managers fan out (peak > 1)", async () => {
    // Control: omitting the limiter restores the unbounded per-core behaviour,
    // proving the cap above is the limiter's doing and not incidental timing.
    const { managers, tracker } = buildManagers(4, undefined, 25);

    await Promise.all(managers.map((m, i) => m.notifyConversation(`acct-${i}`, [msg(`hi ${i}`)])));
    await waitForL1Idle(managers);

    expect(tracker.runs).toBe(4);
    expect(tracker.peak).toBeGreaterThan(1);

    await Promise.all(managers.map((m) => m.destroy()));
  });
});
