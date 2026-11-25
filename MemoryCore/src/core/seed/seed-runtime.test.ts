import { describe, expect, it, vi } from "vitest";
import type { MemoryPipelineManager } from "../../utils/pipeline-manager.js";
import { waitForPipelineIdle } from "./seed-runtime.js";

describe("seed full pipeline idle wait", () => {
  it("waits for L2 pending work and all queues to remain idle", async () => {
    let polls = 0;
    const scheduler = {
      getQueueSizes: vi.fn(() => {
        polls++;
        const idle = polls > 1;
        return {
          l1: 0,
          l2: 0,
          l3: 0,
          l1Pending: false,
          l2Pending: !idle,
          l3Pending: false,
          l1Idle: true,
          l2Idle: idle,
          l3Idle: true,
        };
      }),
      getBufferedMessageCount: vi.fn(() => 0),
      getSessionState: vi.fn(() => ({
        conversation_count: 0,
        l2_pending_l1_count: polls > 1 ? 0 : 1,
      })),
    } as unknown as MemoryPipelineManager;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    await waitForPipelineIdle(
      scheduler,
      ["session-1"],
      logger,
      { pollIntervalMs: 0, stableRounds: 3, maxWaitMs: 1_000 },
    );

    expect(scheduler.getQueueSizes).toHaveBeenCalledTimes(4);
    expect(scheduler.getSessionState).toHaveBeenCalledTimes(4);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
