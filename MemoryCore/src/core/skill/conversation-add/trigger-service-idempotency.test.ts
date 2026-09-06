import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StorageAdapter } from "../../storage/adapter.js";
import { LocalStorageBackend } from "../../storage/local-backend.js";
import { LocalSkillAgentTaskQueue } from "./agent-task-queue.js";
import { SkillBufferStorage, type SessionKey } from "./buffer-storage.js";
import { SkillTriggerService } from "./trigger-service.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "tdai-skill-trigger-idempotency-"));
  tempDirs.push(rootDir);
  const storage = new StorageAdapter(new LocalStorageBackend(rootDir));
  const buffer = new SkillBufferStorage({ storage });
  const queue = new LocalSkillAgentTaskQueue();
  const trigger = new SkillTriggerService({ buffer, queue, now: () => 1234 });
  return { buffer, queue, trigger };
}

const session: SessionKey = {
  instance_id: "instance",
  space_id: "space",
  user_id: "user",
  team_id: "team",
  agent_id: "agent",
  session_id: "session-a",
};

describe("SkillTriggerService idempotent archives", () => {
  it("writes the archive at the exact key registered on the task", async () => {
    const { buffer, trigger } = fixture();
    const payload = { messages: [{ role: "user", content: "hello" }] };

    const result = await trigger.archive({
      session,
      bufferAtTrigger: payload,
      idempotencyKeyHash: "a".repeat(64),
    });

    expect(result.archiveKey).toBe(buffer.idempotentArchiveKey(session, "a".repeat(64)));
    expect(await buffer.readArchive(result.archiveKey)).toEqual(payload);
    expect(await buffer.readArchive(buffer.archiveKey(session, 1234))).toBeNull();
  });

  it("scopes deterministic task IDs by the complete session identity", async () => {
    const { buffer, trigger } = fixture();
    const payload = { messages: [{ role: "user", content: "hello" }] };
    const secondSession = { ...session, session_id: "session-b" };
    const idempotencyKeyHash = "b".repeat(64);

    const first = await trigger.archive({ session, bufferAtTrigger: payload, idempotencyKeyHash });
    const second = await trigger.archive({ session: secondSession, bufferAtTrigger: payload, idempotencyKeyHash });

    expect(second.taskId).not.toBe(first.taskId);
    const tasks = await buffer.readTasks({
      instance_id: session.instance_id,
      space_id: session.space_id,
      user_id: session.user_id,
      team_id: session.team_id,
      agent_id: session.agent_id,
    });
    expect(tasks.tasks.map((task) => task.task_id)).toEqual([first.taskId, second.taskId]);
    expect(tasks.tasks.map((task) => task.session_id)).toEqual(["session-a", "session-b"]);
  });

  it("does not recreate an idempotent task after the worker consumed it", async () => {
    const { buffer, trigger } = fixture();
    const payload = { messages: [{ role: "user", content: "hello" }] };
    const idempotencyKeyHash = "c".repeat(64);
    const agent = {
      instance_id: session.instance_id,
      space_id: session.space_id,
      user_id: session.user_id,
      team_id: session.team_id,
      agent_id: session.agent_id,
    };

    const first = await trigger.archive({ session, bufferAtTrigger: payload, idempotencyKeyHash });
    const tasks = await buffer.readTasks(agent);
    await buffer.writeTasks(agent, { ...tasks, tasks: [] });

    const replay = await trigger.archive({ session, bufferAtTrigger: payload, idempotencyKeyHash });

    expect(replay).toEqual(first);
    expect((await buffer.readTasks(agent)).tasks).toEqual([]);
  });

  it("retries enqueue when registration succeeded but the first enqueue failed", async () => {
    const { buffer, queue, trigger } = fixture();
    const payload = { messages: [{ role: "user", content: "hello" }] };
    const idempotencyKeyHash = "d".repeat(64);
    const enqueue = vi.spyOn(queue, "enqueueAgent")
      .mockRejectedValueOnce(new Error("simulated enqueue failure"));

    await expect(trigger.archive({ session, bufferAtTrigger: payload, idempotencyKeyHash }))
      .rejects.toThrow("simulated enqueue failure");
    const replay = await trigger.archive({ session, bufferAtTrigger: payload, idempotencyKeyHash });

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect((await buffer.readTasks({
      instance_id: session.instance_id,
      space_id: session.space_id,
      user_id: session.user_id,
      team_id: session.team_id,
      agent_id: session.agent_id,
    })).tasks).toHaveLength(1);
    expect(replay.archiveKey).toBe(buffer.idempotentArchiveKey(session, idempotencyKeyHash));
  });

  it("repairs a set-only agent left by a partial Redis-style enqueue", async () => {
    const { buffer, queue, trigger } = fixture();
    const payload = { messages: [{ role: "user", content: "hello" }] };
    const idempotencyKeyHash = "e".repeat(64);
    const agent = {
      instance_id: session.instance_id,
      space_id: session.space_id,
      user_id: session.user_id,
      team_id: session.team_id,
      agent_id: session.agent_id,
    };
    const originalEnqueue = queue.enqueueAgent.bind(queue);
    const enqueue = vi.spyOn(queue, "enqueueAgent")
      .mockImplementationOnce(async (tuple) => {
        await originalEnqueue(tuple);
        await queue.dequeueAgent(0); // Simulate SADD succeeding before LPUSH fails.
        throw new Error("simulated partial enqueue failure");
      })
      .mockImplementation(originalEnqueue);

    await expect(trigger.archive({ session, bufferAtTrigger: payload, idempotencyKeyHash }))
      .rejects.toThrow("simulated partial enqueue failure");
    await expect(trigger.archive({ session, bufferAtTrigger: payload, idempotencyKeyHash }))
      .resolves.toMatchObject({ taskId: expect.stringContaining("skill-extract-task-") });

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(await queue.dequeueAgent(0)).toEqual(agent);
    expect(await queue.dequeueAgent(0)).toBeNull();
    expect((await buffer.readTasks(agent)).tasks).toHaveLength(1);
  });
});
