import { describe, expect, it, vi } from "vitest";
import type { MetadataClient } from "../../meta/client.js";
import type { SessionInitConfig } from "../../types.js";
import { handleSessionInit } from "../index.js";
import { SessionStore } from "../store.js";

function config(overrides: Partial<SessionInitConfig> = {}): SessionInitConfig {
  return {
    enabled: true,
    maxRetries: 3,
    injectAgentContext: true,
    injectTaskContext: true,
    defaultTaskId: "default",
    taskMissingPolicy: "skip",
    headerAutoSelect: {
      enabled: true,
      teamHeader: "x-team-id",
      agentHeader: "x-agent-id",
      taskHeader: "x-task-id",
      onMismatch: "bypass",
    },
    ...overrides,
  };
}

function metadata() {
  return {
    listTeams: vi.fn().mockResolvedValue([{ team_id: "team-1", name: "Team One" }]),
    listAgents: vi.fn().mockResolvedValue([{ agent_id: "agent-1", name: "Agent One" }]),
    listTasks: vi.fn().mockResolvedValue([{ task_id: "task-1", title: "Task One" }]),
    getAgent: vi.fn().mockResolvedValue({
      agent_id: "agent-1",
      name: "Agent One",
      description: "Agent profile",
      prompt: "Be useful",
    }),
    getTask: vi.fn().mockResolvedValue({ task_id: "task-1", title: "Task One" }),
  };
}

describe("header-only session dispatch", () => {
  it("registers OpenClaw with team+agent and no task without emitting a form", async () => {
    const store = new SessionStore();
    const client = metadata();
    const result = await handleSessionInit(
      "conversation-1",
      "user-1",
      [{ role: "user", content: "hello" }],
      config(),
      store,
      { stream: false, modelId: "glm-5.2", protocol: "openai" },
      "openclaw",
      client as unknown as MetadataClient,
      "sk-mem-test",
      "space-1",
      { teamId: "team-1", agentId: "agent-1" },
    );

    expect(result.intercepted).toBe(false);
    expect(result.response).toBeUndefined();
    expect(result.bypassed).toBe(false);
    expect(result.sessionInfo).toMatchObject({
      session_id: "conversation-1",
      team_id: "team-1",
      agent_id: "agent-1",
      user_id: "user-1",
      space_id: "space-1",
    });
    expect(result.sessionInfo?.task_id).toBeUndefined();
    expect(store.get("openclaw:conversation-1")).toMatchObject({
      status: "initialized",
      bypassed: false,
    });
  });

  it("bypasses an invalid Hermes task even when onMismatch=form", async () => {
    const store = new SessionStore();
    const client = metadata();
    const cfg = config({
      headerAutoSelect: {
        enabled: true,
        teamHeader: "x-team-id",
        agentHeader: "x-agent-id",
        taskHeader: "x-task-id",
        onMismatch: "form",
      },
    });
    const result = await handleSessionInit(
      "conversation-2",
      "user-1",
      [{ role: "user", content: "hello" }],
      cfg,
      store,
      { stream: true, modelId: "glm-5.2", protocol: "openai" },
      "hermes",
      client as unknown as MetadataClient,
      "sk-mem-test",
      "space-1",
      { teamId: "team-1", agentId: "agent-1", taskId: "invalid-task" },
    );

    expect(result).toMatchObject({ intercepted: false, bypassed: true });
    expect(result.response).toBeUndefined();
    expect(store.get("hermes:conversation-2")).toMatchObject({
      status: "initialized",
      bypassed: true,
    });
  });

  it("bypasses missing header identity without querying metadata or entering a form", async () => {
    const store = new SessionStore();
    const client = metadata();
    const result = await handleSessionInit(
      "conversation-3",
      "user-1",
      [{ role: "user", content: "hello" }],
      config(),
      store,
      { stream: false, modelId: "glm-5.2", protocol: "openai" },
      "openclaw",
      client as unknown as MetadataClient,
      "sk-mem-test",
      "space-1",
      undefined,
    );

    expect(result).toMatchObject({ intercepted: false, bypassed: true });
    expect(result.response).toBeUndefined();
    expect(client.listTeams).not.toHaveBeenCalled();
  });
});
