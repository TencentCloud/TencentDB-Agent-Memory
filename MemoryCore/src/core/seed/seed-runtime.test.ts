/**
 * Tests for #505 — waitForL1Idle must return promptly once L1 is idle and no
 * messages are buffered, even when a residual conversation_count (rounds not
 * yet reaching everyNConversations) is still non-zero. Previously it spun
 * until maxWait, blocking the seed loop and stalling later rounds' L1
 * extraction.
 */

import { describe, expect, it } from "vitest";
import { waitForL1Idle } from "./seed-runtime.js";

const logger = {
  warn: () => {},
  debug: () => {},
  info: () => {},
} as never;

function makeScheduler(opts: {
  l1Idle?: boolean;
  buffered?: number;
  conversationCount?: number;
}) {
  return {
    getQueueSizes: () => ({
      l1: 0, l2: 0, l3: 0,
      l1Pending: false, l2Pending: false, l3Pending: false,
      l1Idle: opts.l1Idle ?? true, l2Idle: true, l3Idle: true,
    }),
    getBufferedMessageCount: () => opts.buffered ?? 0,
    getSessionState: () => ({ conversation_count: opts.conversationCount ?? 0 }),
  } as never;
}

describe("waitForL1Idle (#505)", () => {
  it("returns promptly when L1 is idle with a residual conversation_count", async () => {
    const scheduler = makeScheduler({ l1Idle: true, buffered: 0, conversationCount: 5 });
    const start = Date.now();
    await waitForL1Idle(scheduler, ["sess-1"], logger, {
      pollIntervalMs: 10, stableRounds: 2, maxWaitMs: 5000,
    });
    // Should satisfy the idle condition in a few polls — NOT spin to maxWait.
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("waits while L1 is not idle, then returns once it becomes idle", async () => {
    let busy = true;
    const scheduler = {
      getQueueSizes: () => ({
        l1: 0, l2: 0, l3: 0,
        l1Pending: false, l2Pending: false, l3Pending: false,
        l1Idle: !busy, l2Idle: true, l3Idle: true,
      }),
      getBufferedMessageCount: () => 0,
      getSessionState: () => ({ conversation_count: 1 }),
    } as never;
    setTimeout(() => { busy = false; }, 50);

    const start = Date.now();
    await waitForL1Idle(scheduler, ["sess-1"], logger, {
      pollIntervalMs: 10, stableRounds: 2, maxWaitMs: 5000,
    });
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });
});
