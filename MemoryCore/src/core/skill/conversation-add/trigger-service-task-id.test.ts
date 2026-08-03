import { describe, expect, it, vi } from "vitest";

const cryptoMocks = vi.hoisted(() => ({
  randomUUID: vi.fn(),
  randomBytes: vi.fn(),
}));

vi.mock("node:crypto", () => ({
  randomUUID: cryptoMocks.randomUUID,
  randomBytes: cryptoMocks.randomBytes,
}));
vi.mock("../../report/obs-logger.js", () => ({
  obsLogger: { info: vi.fn() },
}));

import type { ISkillAgentTaskQueue } from "./agent-task-queue.js";
import type {
  AgentTasksDoc,
  SessionKey,
  SkillBufferStorage,
} from "./buffer-storage.js";
import { SkillTriggerService } from "./trigger-service.js";

describe("SkillTriggerService task ids", () => {
  it("does not collapse UUIDs that share their first eight hex digits", async () => {
    cryptoMocks.randomUUID
      .mockReturnValueOnce("deadbeef-0000-4000-8000-000000000001")
      .mockReturnValueOnce("deadbeef-0000-4000-8000-000000000002");
    let byte = 0;
    cryptoMocks.randomBytes.mockImplementation((size: number) =>
      Buffer.alloc(size, byte++),
    );

    const session: SessionKey = {
      space_id: "space-1",
      user_id: "user-1",
      team_id: "team-1",
      agent_id: "agent-1",
      session_id: "session-1",
    };
    let tasks: AgentTasksDoc = {
      team_id: session.team_id,
      agent_id: session.agent_id,
      updated_at_ms: 0,
      tasks: [],
    };

    const buffer = {
      archiveKey: vi.fn(
        (_session: SessionKey, archivedAtMs: number) =>
          `archive-${archivedAtMs}`,
      ),
      writeArchive: vi.fn().mockResolvedValue(undefined),
      readTasks: vi.fn().mockImplementation(async () => ({
        ...tasks,
        tasks: [...tasks.tasks],
      })),
      writeTasks: vi.fn().mockImplementation(async (_agent, next) => {
        tasks = { ...next, tasks: [...next.tasks] };
      }),
    } as unknown as SkillBufferStorage;
    const queue = {
      withTasksMutex: vi.fn(
        async (_agent, _opts, fn: () => Promise<unknown>) => fn(),
      ),
      enqueueAgent: vi.fn().mockResolvedValue(true),
    } as unknown as ISkillAgentTaskQueue;

    let now = 1_000;
    const service = new SkillTriggerService({
      buffer,
      queue,
      now: () => now++,
    });
    const input = {
      session,
      bufferAtTrigger: {
        messages: [{ role: "user", content: "remember this" }],
      },
    };

    const first = await service.archive(input);
    const second = await service.archive(input);

    expect(first.taskId).toMatch(/^skill-extract-task-[0-9A-Za-z]{12}$/);
    expect(second.taskId).toMatch(/^skill-extract-task-[0-9A-Za-z]{12}$/);
    expect(second.taskId).not.toBe(first.taskId);
    expect(tasks.tasks.map((task) => task.task_id)).toEqual([
      first.taskId,
      second.taskId,
    ]);
  });
});
