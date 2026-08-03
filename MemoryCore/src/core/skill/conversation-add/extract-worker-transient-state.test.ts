import { describe, expect, it, vi } from "vitest";

vi.mock("../../report/otel-context.js", () => ({
  runInRootContext: <T>(fn: () => T): T => fn(),
}));
vi.mock("../../report/obs-logger.js", () => ({
  obsLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("../../report/trace.js", () => ({
  trace: { report: vi.fn() },
}));

import type {
  AgentTuple,
  ISkillAgentTaskQueue,
} from "./agent-task-queue.js";
import type {
  SkillBufferStorage,
  SkillTaskEntry,
} from "./buffer-storage.js";
import { SkillConversationExtractWorker } from "./extract-worker.js";

describe("SkillConversationExtractWorker transient state", () => {
  it("starts a fresh failure streak after a task recovers", async () => {
    const agent: AgentTuple = {
      space_id: "space-1",
      user_id: "user-1",
      team_id: "team-1",
      agent_id: "agent-1",
    };
    const task: SkillTaskEntry = {
      task_id: "task-reused",
      session_id: "session-1",
      user_id: agent.user_id,
      team_id: agent.team_id,
      agent_id: agent.agent_id,
      space_id: agent.space_id,
      archive_key: "archive-1",
      archived_at_ms: 1,
      enqueued_at_ms: 1,
    };

    const queue = {
      dequeueAgent: vi.fn().mockResolvedValue(agent),
      acquireExtractLock: vi.fn().mockResolvedValue({
        key: "agent-lock",
        token: "token",
      }),
      renewExtractLock: vi.fn().mockResolvedValue(true),
      releaseExtractLock: vi.fn().mockResolvedValue(undefined),
      requeueAgent: vi.fn().mockResolvedValue(undefined),
      removeAgent: vi.fn().mockResolvedValue(undefined),
      enqueueAgent: vi.fn().mockResolvedValue(true),
      withTasksMutex: vi.fn(
        async (
          _tuple: AgentTuple,
          _opts: { lockTtlMs: number; waitDeadlineMs: number },
          fn: () => Promise<unknown>,
        ) => fn(),
      ),
    } as unknown as ISkillAgentTaskQueue;

    const buffer = {
      readTasks: vi.fn().mockImplementation(async () => ({
        team_id: agent.team_id,
        agent_id: agent.agent_id,
        updated_at_ms: 1,
        tasks: [{ ...task }],
      })),
      writeTasks: vi.fn().mockResolvedValue(undefined),
      readArchive: vi.fn().mockResolvedValue({
        messages: [{ role: "user", content: "remember this" }],
      }),
    } as unknown as SkillBufferStorage;

    const extractor = {
      extract: vi
        .fn()
        .mockRejectedValueOnce(new Error("fetch failed"))
        .mockResolvedValueOnce({ candidates: [] })
        .mockRejectedValueOnce(new Error("fetch failed")),
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const worker = new SkillConversationExtractWorker({
      workerId: "worker-1",
      buffer,
      queue,
      extractor,
      sink: { applyCandidates: vi.fn().mockResolvedValue(undefined) },
      logger,
      brpopBlockMs: 0,
      extractLockRenewIntervalMs: 0,
      failureRequeueSleepMs: 0,
    });

    await worker.runOnce(); // transient failure: streak = 1
    await worker.runOnce(); // success: terminal state should clear the streak
    await worker.runOnce(); // reused id must log as a first failure again

    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error.mock.calls[0]?.[0]).toContain("task=task-reused");
    expect(logger.error.mock.calls[1]?.[0]).toContain("task=task-reused");
  });
});
