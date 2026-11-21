import { describe, expect, it, vi } from "vitest";
import type { AgentEntity, MetadataClient } from "../../meta/client.js";
import {
  isAgentVisibleToSessionUser,
  visibleSessionAgents,
} from "../agent-visibility.js";
import { fetchTeamsAndAgents as fetchClaudeCodeTeams } from "../claude-code/init.js";
import { fetchTeamsAndAgents as fetchCodeBuddyTeams } from "../codebuddy/init.js";
import type { SessionInitConfig } from "../../types.js";

function agent(
  agentId: string,
  ownerUserId: string,
  visibility?: string,
): AgentEntity {
  return {
    agent_id: agentId,
    team_id: "team-1",
    owner_user_id: ownerUserId,
    name: agentId,
    visibility,
  };
}

describe("session-init agent visibility", () => {
  it("keeps the caller's own agents regardless of visibility", () => {
    const ownPrivate = agent("own-private", "user-a", "private");
    expect(isAgentVisibleToSessionUser(ownPrivate, "user-a")).toBe(true);
  });

  it("keeps another user's team-visible agent for a team member", () => {
    const shared = agent("shared", "user-b", "team");
    expect(isAgentVisibleToSessionUser(shared, "user-a")).toBe(true);
  });

  it.each(["private", "restricted", "agent", "task", undefined])(
    "filters another user's %s agent",
    (visibility) => {
      const hidden = agent("hidden", "user-b", visibility);
      expect(isAgentVisibleToSessionUser(hidden, "user-a")).toBe(false);
    },
  );

  it("filters the complete team list without changing its order", () => {
    const filtered = visibleSessionAgents(
      [
        agent("own", "user-a", "private"),
        agent("shared", "user-b", "team"),
        agent("hidden", "user-b", "private"),
      ],
      "user-a",
    );

    expect(filtered.map((item) => item.agent_id)).toEqual(["own", "shared"]);
  });

  it.each([
    ["CodeBuddy", fetchCodeBuddyTeams],
    ["Claude Code", fetchClaudeCodeTeams],
  ])(
    "%s requests team agents and filters them for the caller",
    async (_label, loadTeams) => {
      const metadataClient = {
        listTeams: vi.fn().mockResolvedValue([
          { team_id: "team-1", name: "Team One" },
        ]),
        listAgents: vi.fn().mockResolvedValue([
          agent("own", "user-a", "private"),
          agent("shared", "user-b", "team"),
          agent("hidden", "user-b", "private"),
        ]),
        listTasks: vi.fn().mockResolvedValue([
          { task_id: "task-1", title: "Task One" },
        ]),
      } as unknown as MetadataClient;

      const { teams } = await loadTeams(
        "user-a",
        {} as SessionInitConfig,
        metadataClient,
      );

      expect(metadataClient.listAgents).toHaveBeenCalledWith("team-1");
      expect(teams[0].agents.map((item) => item.agent_id)).toEqual([
        "own",
        "shared",
      ]);
    },
  );
});
