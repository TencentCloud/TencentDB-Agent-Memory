import { describe, expect, it } from "vitest";

import type { SessionInitConfig } from "../../types.js";
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
});
