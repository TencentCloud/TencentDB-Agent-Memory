import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  return { buffer, trigger };
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
});
