import { describe, expect, it, vi } from "vitest";

import type { MetadataClient } from "../../../meta/client.js";
import { SessionStore } from "../../store.js";
import type { SessionInitConfig } from "../../../types.js";
import { handleSessionInit } from "../init.js";

const USER_ID = "user-1";
const TARGET_TEAM = "team-target";
const OTHER_TEAM = "team-other";
const TARGET_AGENT = "agent-target";
const TARGET_TASK = "task-target";

function config(onMismatch: "form" | "bypass" = "form"): SessionInitConfig {
  return {
    enabled: true,
    maxRetries: 3,
    headerAutoSelect: {
      enabled: true,
      teamHeader: "x-team-id",
      agentHeader: "x-agent-id",
      taskHeader: "x-task-id",
      onMismatch,
    },
  } as SessionInitConfig;
}

function team(team_id: string, name = team_id) {
  return { team_id, name };
}

function agent(agent_id: string, team_id = TARGET_TEAM) {
  return { agent_id, team_id, name: agent_id };
}

function task(task_id: string, team_id = TARGET_TEAM) {
  return { task_id, team_id, title: task_id };
}

function metadata(overrides: Partial<Record<keyof MetadataClient, unknown>> = {}) {
  return {
    listTeams: vi.fn().mockResolvedValue([team(TARGET_TEAM), team(OTHER_TEAM)]),
    listAgents: vi.fn().mockImplementation(async (teamId: string) => {
      if (teamId === TARGET_TEAM) return [agent(TARGET_AGENT)];
      return [agent("agent-other", OTHER_TEAM)];
    }),
    listTasks: vi.fn().mockImplementation(async (teamId: string) => {
      if (teamId === TARGET_TEAM) return [task(TARGET_TASK)];
      return [task("task-other", OTHER_TEAM)];
    }),
    getAgent: vi.fn().mockResolvedValue(agent(TARGET_AGENT)),
    getTask: vi.fn().mockResolvedValue(task(TARGET_TASK)),
    ...overrides,
  } as unknown as MetadataClient;
}

async function init(
  metadataClient: MetadataClient,
  presetIdentity?: { teamId?: string; agentId?: string; taskId?: string },
  sessionConfig = config(),
  store = new SessionStore(),
) {
  return handleSessionInit(
    "session-1",
    USER_ID,
    [],
    sessionConfig,
    store,
    { stream: false, modelId: "test", protocol: "openai" },
    metadataClient,
    undefined,
    undefined,
    presetIdentity,
  );
}

describe("Claude Code header-directed session initialization", () => {
  it("loads only the requested Team directory", async () => {
    const client = metadata({
      listAgents: vi.fn().mockImplementation(async (teamId: string) => {
        if (teamId !== TARGET_TEAM) throw new Error("unrelated team must not be queried");
        return [agent(TARGET_AGENT)];
      }),
      listTasks: vi.fn().mockImplementation(async (teamId: string) => {
        if (teamId !== TARGET_TEAM) throw new Error("unrelated team must not be queried");
        return [task(TARGET_TASK)];
      }),
    });

    const result = await init(client, {
      teamId: TARGET_TEAM,
      agentId: TARGET_AGENT,
      taskId: TARGET_TASK,
    });

    expect(result.intercepted).toBe(false);
    expect(result.justRegistered).toBe(true);
    expect(client.listTeams).toHaveBeenCalledWith(USER_ID);
    expect(client.listAgents).toHaveBeenCalledTimes(1);
    expect(client.listAgents).toHaveBeenCalledWith(TARGET_TEAM, USER_ID);
    expect(client.listTasks).toHaveBeenCalledTimes(1);
    expect(client.listTasks).toHaveBeenCalledWith(TARGET_TEAM);
  });

  it("preserves form fallback when the requested Team is not visible", async () => {
    const client = metadata({
      listTeams: vi.fn().mockResolvedValue([team(OTHER_TEAM)]),
    });

    const result = await init(client, {
      teamId: TARGET_TEAM,
      agentId: TARGET_AGENT,
      taskId: TARGET_TASK,
    });

    expect(result.intercepted).toBe(true);
    // The mismatch form keeps the original full-directory behavior.
    expect(client.listAgents).toHaveBeenCalledWith(OTHER_TEAM, USER_ID);
    expect(client.listTasks).toHaveBeenCalledWith(OTHER_TEAM);
  });

  it("preserves bypass behavior for an invisible Team with onMismatch=bypass", async () => {
    const client = metadata({
      listTeams: vi.fn().mockResolvedValue([team(OTHER_TEAM)]),
    });

    const result = await init(
      client,
      { teamId: TARGET_TEAM, agentId: TARGET_AGENT },
      config("bypass"),
    );

    expect(result.intercepted).toBe(false);
    expect(result.bypassed).toBe(true);
    expect(client.listAgents).not.toHaveBeenCalled();
    expect(client.listTasks).not.toHaveBeenCalled();
  });

  it("keeps mismatch handling when the Agent is not in the requested Team", async () => {
    const client = metadata({
      listAgents: vi.fn().mockImplementation(async (teamId: string) => {
        if (teamId === TARGET_TEAM) return [agent("different-agent")];
        return [agent("agent-other", OTHER_TEAM)];
      }),
    });

    const result = await init(client, {
      teamId: TARGET_TEAM,
      agentId: TARGET_AGENT,
      taskId: TARGET_TASK,
    });

    expect(result.intercepted).toBe(true);
    // The initial target-only lookup is followed by the original full lookup
    // so the interactive fallback still has the complete visible directory.
    expect(client.listAgents).toHaveBeenCalledWith(TARGET_TEAM, USER_ID);
    expect(client.listAgents).toHaveBeenCalledWith(OTHER_TEAM, USER_ID);
    expect(client.listTasks).toHaveBeenCalledWith(TARGET_TEAM);
    expect(client.listTasks).toHaveBeenCalledWith(OTHER_TEAM);
  });

  it("keeps task-optional registration for a stale task header", async () => {
    const client = metadata({
      getTask: vi.fn().mockRejectedValue(new Error("task not found")),
    });

    const result = await init(client, {
      teamId: TARGET_TEAM,
      agentId: TARGET_AGENT,
      taskId: "stale-task",
    });

    expect(result.intercepted).toBe(false);
    expect(result.justRegistered).toBe(true);
    expect(result.sessionInfo?.team_id).toBe(TARGET_TEAM);
    expect(result.sessionInfo?.agent_id).toBe(TARGET_AGENT);
    expect(result.sessionInfo?.task_id).toBeUndefined();
  });

  it("does not persist a bypass when the target directory temporarily fails", async () => {
    const store = new SessionStore();
    const client = metadata({
      listAgents: vi.fn()
        .mockRejectedValueOnce(new Error("timeout"))
        .mockResolvedValue([agent(TARGET_AGENT)]),
    });
    const preset = {
      teamId: TARGET_TEAM,
      agentId: TARGET_AGENT,
      taskId: TARGET_TASK,
    };

    const first = await init(client, preset, config(), store);

    expect(first.intercepted).toBe(false);
    expect(first.bypassed).toBeUndefined();
    expect(store.get("claude-code:session-1")).toBeUndefined();

    const second = await init(client, preset, config(), store);

    expect(second.intercepted).toBe(false);
    expect(second.justRegistered).toBe(true);
    expect(second.bypassed).toBeUndefined();
    expect(client.listAgents).toHaveBeenCalledTimes(2);
  });

  it("keeps the full directory flow when no Header preset is supplied", async () => {
    const client = metadata();

    const result = await init(client);

    expect(result.intercepted).toBe(true);
    expect(client.listAgents).toHaveBeenCalledTimes(2);
    expect(client.listTasks).toHaveBeenCalledTimes(2);
    expect(client.listAgents).toHaveBeenCalledWith(TARGET_TEAM, USER_ID);
    expect(client.listAgents).toHaveBeenCalledWith(OTHER_TEAM, USER_ID);
    expect(client.listTasks).toHaveBeenCalledWith(TARGET_TEAM);
    expect(client.listTasks).toHaveBeenCalledWith(OTHER_TEAM);
  });
});
