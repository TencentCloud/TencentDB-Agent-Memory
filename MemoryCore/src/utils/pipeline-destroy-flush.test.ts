/**
 * Regression tests for the destroy-time flush contract (issue #1049).
 *
 * `destroy()` sets `destroyed = true` *before* draining, and `_doFlush()`
 * explicitly flushes pending L2 timers so the L2 task still runs. `runL2()`
 * then calls `triggerL3()`, which used to return immediately on
 * `destroyed === true` — so the flush ran L2, dropped the L3 persona
 * generation it triggered, observed both queues idle, and logged
 * "Pipeline flushed successfully". That L3 work is unrecoverable on restart,
 * because `runL2()` has already zeroed `l2_pending_l1_count`.
 *
 * There was a second, compounding defect: `_doFlush()` awaited
 * `Promise.all([l2Queue.onIdle(), l3Queue.onIdle()])`. `SerialQueue.onIdle()`
 * resolves immediately when a queue is empty, so the L3 promise settled before
 * the flushed L2 ever enqueued its L3 task. Draining L3 only after L2 has
 * finished is what makes the dependency order observable.
 */
import { describe, it, expect } from "vitest";
import { MemoryPipelineManager } from "./pipeline-manager.js";
import type { PipelineConfig, L1RunnerResult } from "./pipeline-manager.js";
import type { Logger } from "../types.js";

const config: PipelineConfig = {
  everyNConversations: 1,
  enableWarmup: false,
  l1: { idleTimeoutSeconds: 60 },
  l2: {
    // Long enough that the naturally-armed L2 timer is still pending when
    // destroy() runs, so the flush has to run L2 itself.
    delayAfterL1Seconds: 60,
    minIntervalSeconds: 900,
    maxIntervalSeconds: 3600,
    sessionActiveWindowHours: 24,
  },
};

interface Counters {
  l1: number;
  l2: number;
  l3: number;
}

interface Harness {
  pipeline: MemoryPipelineManager;
  counters: Counters;
  lines: string[];
}

function buildPipeline(): Harness {
  const counters: Counters = { l1: 0, l2: 0, l3: 0 };
  const lines: string[] = [];
  const logger: Logger = {
    debug: (m) => lines.push(m),
    info: (m) => lines.push(m),
    warn: (m) => lines.push(m),
    error: (m) => lines.push(m),
  };
  const pipeline = new MemoryPipelineManager(config, logger);

  pipeline.setL1Runner(async (): Promise<L1RunnerResult> => {
    counters.l1 += 1;
    return {};
  });
  pipeline.setL2Runner(async () => {
    counters.l2 += 1;
    return { latestCursor: new Date().toISOString() };
  });
  pipeline.setL3Runner(async () => {
    counters.l3 += 1;
  });

  return { pipeline, counters, lines };
}

/** Wait for the L1 queue to go idle, mirroring seed-runtime's waitForL1Idle. */
async function waitForL1Idle(pipeline: MemoryPipelineManager): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const q = pipeline.getQueueSizes();
    if (q.l1 === 0 && !q.l1Pending) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("L1 queue never went idle");
}

describe("MemoryPipelineManager.destroy — L3 cascade survives the flush", () => {
  it("drains L1 → L2 → L3 when destroy() flushes a pending L2 timer", async () => {
    const { pipeline, counters } = buildPipeline();

    await pipeline.notifyConversation("s-1", [
      { role: "user", content: "hello", timestamp: new Date().toISOString() },
    ]);
    // The L1 completion has armed the L2 schedule timer, which is still
    // pending (delayAfterL1 = 60 s) when destroy() runs.
    await waitForL1Idle(pipeline);
    await pipeline.destroy();

    expect(counters.l1).toBe(1);
    // L2 ran because the flush triggered its timer...
    expect(counters.l2).toBe(1);
    // ...and the L3 task that L2 enqueued was actually awaited, not dropped.
    expect(counters.l3).toBe(1);
    expect(pipeline.getQueueSizes()).toMatchObject({
      l1: 0,
      l2: 0,
      l3: 0,
      l1Idle: true,
      l2Idle: true,
      l3Idle: true,
    });
  });

  it("reports a flush that still has pending work instead of claiming success", async () => {
    const { pipeline, lines } = buildPipeline();

    await pipeline.notifyConversation("s-1", [
      { role: "user", content: "hello", timestamp: new Date().toISOString() },
    ]);
    await waitForL1Idle(pipeline);
    await pipeline.destroy();

    expect(lines).toContain("[memory-tdai] [pipeline] Pipeline flushed successfully");
    expect(lines.join("\n")).not.toContain("Pipeline flush finished with work still pending");
    expect(lines.join("\n")).not.toContain("Pipeline flush timed out or failed");
  });

  it("keeps new L3 work out of the pipeline once shutdown is complete", async () => {
    const { pipeline, counters } = buildPipeline();

    await pipeline.notifyConversation("s-1", [
      { role: "user", content: "hello", timestamp: new Date().toISOString() },
    ]);
    await waitForL1Idle(pipeline);
    await pipeline.destroy();

    // After destroy() returns, `flushing` must be off again so a late L2
    // completion cannot drag the process back into work.
    await pipeline.notifyConversation("s-1", [
      { role: "user", content: "again", timestamp: new Date().toISOString() },
    ]);
    await new Promise((r) => setTimeout(r, 20));

    expect(counters.l1).toBe(1);
    expect(counters.l2).toBe(1);
    expect(counters.l3).toBe(1);
  });
});
