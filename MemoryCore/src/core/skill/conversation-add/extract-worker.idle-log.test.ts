import { describe, expect, it, vi } from "vitest";

const observations = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../../report/obs-logger.js", () => ({
  obsLogger: observations,
}));

import { SkillConversationExtractWorker } from "./extract-worker.js";

describe("SkillConversationExtractWorker contention logging", () => {
  it("does not emit INFO logs when another worker holds the agent lock", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const worker = new SkillConversationExtractWorker({
      workerId: "worker-1",
      buffer: {} as any,
      queue: {
        acquireExtractLock: async () => null,
        getPeekStrategy: () => "lmove",
      } as any,
      extractor: {} as any,
      sink: {} as any,
      logger,
      lockContentionSleepMs: 0,
      lockContentionSleepJitterMs: 0,
    });

    const result = await worker.consumeAgent({
      instance_id: "default",
      space_id: "space",
      user_id: "user",
      team_id: "team",
      agent_id: "agent",
    });

    expect(result.lockContended).toBe(true);
    expect(logger.info).not.toHaveBeenCalled();
    expect(observations.info).not.toHaveBeenCalled();
    expect(observations.debug).toHaveBeenCalledWith(
      "skill.worker.acquire_lock",
      expect.objectContaining({ acquired: false }),
    );
  });
});
