import { describe, expect, it, vi } from "vitest";
import { handleSessionInit } from "../index.js";
import { SessionStore } from "../store.js";
import { normalizeSessionTask } from "../task.js";
import type { SessionInitConfig } from "../../types.js";
import type { SessionInitState } from "../types.js";
import type { MetadataClient } from "../../meta/client.js";
import type { SessionRepo } from "../../db/sessionRepo.js";
import type { BindingRepo, SessionBinding } from "../../db/binding-repo.js";

const config = { enabled: true, defaultTaskId: "no-task", headerAutoSelect: { enabled: true, onMismatch: "form" } } as SessionInitConfig;
const identity = { spaceId: "space", userId: "user", agentSource: "claude-code", sessionId: "session" };
const key = "claude-code:session";
function metadata() {
  return {
    listTeams: vi.fn(async () => [{ team_id: "team", name: "Team" }]),
    listAgents: vi.fn(async () => [{ agent_id: "agent", name: "Agent" }]),
    listTasks: vi.fn(async () => [{ task_id: "real", title: "Real" }]),
    getAgent: vi.fn(async () => ({ agent_id: "agent", name: "Agent" })),
    getTask: vi.fn(async (id: string) => ({ task_id: id, title: "Real" })),
    appendParticipationLog: vi.fn(async () => ({})),
  };
}
function legacy(taskId = "no-task"): SessionInitState {
  return { status: "initialized", keyId: "session", startedAt: Date.now(), attemptCount: 0,
    sessionInfo: { session_id: "session", team_id: "team", agent_id: "agent", user_id: "user", task_id: taskId, created_at: "date" },
    agentDetail: { id: "agent", name: "Agent" }, taskDetail: { id: taskId, name: "old task" },
  };
}
function repos(state: SessionInitState | null, binding: SessionBinding | null = null) {
  const repo: SessionRepo = { upsert: vi.fn(async (_sp, _u, _src, _sid, next) => { state = structuredClone(next); }),
    getBySessionId: vi.fn(async () => state && structuredClone(state)), deleteBySessionId: vi.fn(),
    loadAllInitialized: vi.fn(async () => state ? [{ ...identity, state: structuredClone(state) }] : []),
  };
  const bindingRepo: BindingRepo = { getBinding: vi.fn(async () => binding), putBinding: vi.fn(async (_sp, _sid, next) => { binding = { ...next }; }),
    deleteBinding: vi.fn(async () => {}), touchLastSeen: vi.fn(async () => {}),
  };
  return { repo, bindingRepo };
}

describe("registration with optional tasks", () => {
  for (const source of ["claude-code", "codebuddy", "codex", "workbuddy", "dsh", "opencode"]) {
    it.each([undefined, "expired", "no-task", "real"])(`${source}: header task %s`, async (taskId) => {
      const client = metadata();
      const result = await handleSessionInit("session", "user", [{ role: "user", content: "hello" }], config,
        new SessionStore(60000, undefined, undefined, "no-task"), { stream: false, modelId: "test" }, source,
        client as unknown as MetadataClient, "test-key", "space", { teamId: "team", agentId: "agent", taskId });
      expect(result.sessionInfo?.agent_id).toBe("agent");
      expect(result.sessionInfo?.task_id).toBe(taskId === "real" ? "real" : undefined);
      expect(client.getTask).toHaveBeenCalledTimes(taskId === "real" ? 1 : 0);
      expect(client.appendParticipationLog).toHaveBeenCalledTimes(taskId === "real" ? 1 : 0);
    });
  }
  it("handles the actual CC no-task form selection, including a virtual marker from older configuration", async () => {
    const client = metadata();
    const store = new SessionStore(60000, undefined, undefined, "no-task");
    await store.set(key, { ...legacy(), status: "pending_task_select", sessionInfo: null,
      selectedTeamId: "team", selectedAgentId: "agent", cachedTeams: [{ team_id: "team", team_name: "Team",
        agents: [{ agent_id: "agent", agent_name: "Agent" }],
        tasks: [{ task_id: "old-placeholder", task_name: "本次不关联任务", isDefault: true }] }] });
    const result = await handleSessionInit("session", "user", [{ role: "user", content: JSON.stringify({ answers: { Task: "本次不关联任务" } }) }],
      config, store, { stream: false, modelId: "test", protocol: "anthropic" }, "claude-code", client as unknown as MetadataClient);
    expect(result.sessionInfo?.task_id).toBeUndefined();
    expect(store.get(key)?.sessionInfo?.task_id).toBeUndefined();
    expect(client.getTask).not.toHaveBeenCalled();
    expect(client.appendParticipationLog).not.toHaveBeenCalled();
  });
});

describe("legacy session recovery", () => {
  it.each(["no-task", "real"])("migrates L2a task %s and survives another store restart", async (taskId) => {
    const { repo, bindingRepo } = repos(legacy(taskId));
    const store = new SessionStore(60000, repo, bindingRepo, "no-task");
    const recovered = await store.getOrRecover(key, identity, {});
    expect(recovered?.sessionInfo?.task_id).toBe(taskId === "real" ? "real" : undefined);
    expect(recovered?.sessionInfo?.agent_id).toBe("agent");
    if (taskId !== "real") {
      expect(recovered?.taskDetail).toBeNull();
      expect(repo.upsert).toHaveBeenCalled();
      expect(bindingRepo.putBinding).toHaveBeenCalledWith("space", "session", expect.objectContaining({ taskId: undefined, agentId: "agent" }));
    }
    const restarted = new SessionStore(60000, repo, bindingRepo, "no-task");
    expect((await restarted.getOrRecover(key, identity, {}))?.sessionInfo?.task_id).toBe(taskId === "real" ? "real" : undefined);
  });
  it("cleans startup-hydrated state before a bridge can read it", async () => {
    const { repo } = repos(legacy());
    const store = new SessionStore(60000, repo, undefined, "no-task");
    await store.hydrateFromDb();
    expect(store.get(key)?.sessionInfo?.task_id).toBeUndefined();
    expect(repo.upsert).not.toHaveBeenCalled();
    await store.getOrRecover(key, identity, {});
    expect(repo.upsert).toHaveBeenCalled();
  });
  it("does not overwrite a newer persistent session while cleaning stale L1", async () => {
    const { repo } = repos(legacy());
    const store = new SessionStore(60000, repo, undefined, "no-task");
    await store.hydrateFromDb();
    await repo.upsert("space", "user", "claude-code", "session", legacy("real"));
    vi.mocked(repo.upsert).mockClear();
    expect(store.get(key)?.sessionInfo?.task_id).toBeUndefined();
    expect(repo.upsert).not.toHaveBeenCalled();
    expect((await store.getOrRecover(key, identity, {}))?.sessionInfo?.task_id).toBe("real");
  });
  it("recovers an old binding without fetching the virtual task", async () => {
    const { bindingRepo } = repos(null, { outcome: "initialized", userId: "user", teamId: "team", agentId: "agent", taskId: "no-task" });
    const client = metadata();
    const store = new SessionStore(60000, undefined, bindingRepo, "no-task");
    const recovered = await store.getOrRecover(key, identity, { metadataClient: client as unknown as MetadataClient });
    expect(recovered?.sessionInfo?.task_id).toBeUndefined();
    expect(recovered?.sessionInfo?.agent_id).toBe("agent");
    expect(client.getTask).not.toHaveBeenCalled();
  });
  it("preserves real IDs and bypass state, and honors old virtual markers", () => {
    const real = legacy("default");
    expect(normalizeSessionTask(real, "no-task")).toBe(real);
    const bypassed = { ...legacy(), bypassed: true, sessionInfo: null };
    expect(normalizeSessionTask(bypassed, "no-task")).toBe(bypassed);
    const old = { ...legacy("previous"), cachedTeams: [{ team_id: "team", team_name: "Team", agents: [], tasks: [{ task_id: "previous", task_name: "None", isDefault: true }] }] };
    expect(normalizeSessionTask(old, "no-task").sessionInfo?.task_id).toBeUndefined();
  });
});
