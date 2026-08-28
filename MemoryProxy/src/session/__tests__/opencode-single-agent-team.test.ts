import { describe, expect, it } from "vitest";

import type { SessionInitConfig } from "../../types.js";
import type { MetadataClient } from "../../meta/client.js";
import { handleSessionInit } from "../index.js";
import { SessionStore } from "../store.js";
import type { SessionInitState, TeamOption } from "../types.js";

class InMemorySessionStore {
  readonly states = new Map<string, SessionInitState>();

  get(key: string): SessionInitState | undefined {
    return this.states.get(key);
  }

  async set(key: string, state: SessionInitState): Promise<void> {
    this.states.set(key, state);
  }
}

const config: SessionInitConfig = {
  enabled: true,
  maxRetries: 3,
};

const headerAutoSelectConfig: SessionInitConfig = {
  ...config,
  headerAutoSelect: {
    enabled: true,
    teamHeader: "x-team-id",
    agentHeader: "x-agent-id",
    taskHeader: "x-task-id",
    onMismatch: "form",
  },
};

function sessionStore(initialState: SessionInitState): InMemorySessionStore {
  const store = new InMemorySessionStore();
  store.states.set("opencode:session-1", initialState);
  return store;
}

function teams(tasksInSelectedTeam: TeamOption["tasks"]): TeamOption[] {
  return [
    {
      team_id: "team-selected-0001",
      team_name: "Selected Team",
      agents: [{ agent_id: "agent-only-0001", agent_name: "Only Agent" }],
      tasks: tasksInSelectedTeam,
    },
    {
      team_id: "team-other-000002",
      team_name: "Other Team",
      agents: [{ agent_id: "agent-other-0002", agent_name: "Other Agent" }],
      tasks: [{ task_id: "task-other-00002", task_name: "Other Task" }],
    },
  ];
}

function pendingTeamSelection(cachedTeams: TeamOption[]): SessionInitState {
  return {
    status: "pending_team_select",
    keyId: "session-1",
    startedAt: 1,
    attemptCount: 0,
    userId: "user-1",
    cachedTeams,
  };
}

function selectedTeamAnswer(): Record<string, unknown>[] {
  return [{ role: "user", content: "Selected Team" }];
}

function metadataClient(cachedTeams: TeamOption[]): MetadataClient {
  return {
    listTeams: async () => cachedTeams.map((team) => ({
      team_id: team.team_id,
      name: team.team_name,
    })),
    listAgents: async (teamId: string) => {
      const team = cachedTeams.find((item) => item.team_id === teamId);
      return (team?.agents ?? []).map((agent) => ({
        agent_id: agent.agent_id,
        team_id: teamId,
        name: agent.agent_name,
        description: agent.description,
      }));
    },
    listTasks: async (teamId: string) => {
      const team = cachedTeams.find((item) => item.team_id === teamId);
      return (team?.tasks ?? []).map((task) => ({
        task_id: task.task_id,
        team_id: teamId,
        title: task.task_name,
      }));
    },
    getAgent: async (agentId: string) => ({
      agent_id: agentId,
      team_id: "team-selected-0001",
      name: "Only Agent",
    }),
    getTask: async (taskId: string) => ({
      task_id: taskId,
      team_id: "team-selected-0001",
      title: "Only Task",
    }),
  } as unknown as MetadataClient;
}

describe("OpenCode session initialization for a selected single-agent Team", () => {
  it("skips agent selection and renders task selection when the selected Team has multiple Tasks", async () => {
    const cachedTeams = teams([
      { task_id: "task-first-00001", task_name: "First Task" },
      { task_id: "task-second-0002", task_name: "Second Task" },
    ]);
    const store = sessionStore(pendingTeamSelection(cachedTeams));

    const result = await handleSessionInit(
      "session-1",
      "user-1",
      selectedTeamAnswer(),
      config,
      store as unknown as SessionStore,
      { stream: false, modelId: "test-model" },
      "opencode",
    );

    expect(result).toMatchObject({
      intercepted: true,
      formData: {
        stage: "task_select",
        selectedTeamId: "team-selected-0001",
        selectedAgentId: "agent-only-0001",
      },
    });
    expect(store.get("opencode:session-1")).toMatchObject({
      status: "pending_task_select",
      selectedTeamId: "team-selected-0001",
      selectedAgentId: "agent-only-0001",
    });
  });

  it("binds the only Agent and Task without emitting an agent selection form", async () => {
    const cachedTeams = teams([
      { task_id: "task-only-000001", task_name: "Only Task" },
    ]);
    const store = sessionStore(pendingTeamSelection(cachedTeams));

    const result = await handleSessionInit(
      "session-1",
      "user-1",
      selectedTeamAnswer(),
      config,
      store as unknown as SessionStore,
      { stream: false, modelId: "test-model" },
      "opencode",
    );

    expect(result).toMatchObject({
      intercepted: false,
      justRegistered: true,
    });
    expect(store.get("opencode:session-1")).toMatchObject({
      status: "initialized",
      selectedTeamId: "team-selected-0001",
      sessionInfo: {
        team_id: "team-selected-0001",
        agent_id: "agent-only-0001",
        task_id: "task-only-000001",
      },
    });
  });

  it("uses task selection when a Team-only header resolves to one Agent and multiple Tasks", async () => {
    const cachedTeams = teams([
      { task_id: "task-first-00001", task_name: "First Task" },
      { task_id: "task-second-0002", task_name: "Second Task" },
    ]);
    const store = new InMemorySessionStore();

    const result = await handleSessionInit(
      "session-1",
      "user-1",
      [{ role: "user", content: "Start a session" }],
      headerAutoSelectConfig,
      store as unknown as SessionStore,
      { stream: false, modelId: "test-model" },
      "opencode",
      metadataClient(cachedTeams),
      undefined,
      undefined,
      { teamId: "team-selected-0001" },
    );

    expect(result).toMatchObject({
      intercepted: true,
      formData: {
        stage: "task_select",
        selectedTeamId: "team-selected-0001",
        selectedAgentId: "agent-only-0001",
      },
    });
    expect(store.get("opencode:session-1")).toMatchObject({
      status: "pending_task_select",
      selectedTeamId: "team-selected-0001",
      selectedAgentId: "agent-only-0001",
    });
  });

  it("binds the only Agent and Task when a Team-only header resolves to one Task", async () => {
    const cachedTeams = teams([
      { task_id: "task-only-000001", task_name: "Only Task" },
    ]);
    const store = new InMemorySessionStore();

    const result = await handleSessionInit(
      "session-1",
      "user-1",
      [{ role: "user", content: "Start a session" }],
      headerAutoSelectConfig,
      store as unknown as SessionStore,
      { stream: false, modelId: "test-model" },
      "opencode",
      metadataClient(cachedTeams),
      undefined,
      undefined,
      { teamId: "team-selected-0001" },
    );

    expect(result).toMatchObject({
      intercepted: false,
      justRegistered: true,
    });
    expect(store.get("opencode:session-1")).toMatchObject({
      status: "initialized",
      selectedTeamId: "team-selected-0001",
      sessionInfo: {
        team_id: "team-selected-0001",
        agent_id: "agent-only-0001",
        task_id: "task-only-000001",
      },
    });
  });
});
