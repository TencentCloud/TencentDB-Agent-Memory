import { describe, expect, it, vi } from "vitest";

import type { MetadataClient } from "../../meta/client.js";
import { listAccessibleAgentsForTeam } from "../accessible-agents.js";

describe("listAccessibleAgentsForTeam", () => {
  it("includes owned agents and team-visible agents without exposing other private agents", async () => {
    const listAgents = vi.fn().mockResolvedValue([
      {
        agent_id: "agent-owned-private",
        team_id: "team-1",
        owner_user_id: "member-1",
        name: "My private agent",
        visibility: "private",
      },
      {
        agent_id: "agent-admin-team",
        team_id: "team-1",
        owner_user_id: "admin-1",
        name: "Shared team agent",
        visibility: "team",
      },
      {
        agent_id: "agent-admin-private",
        team_id: "team-1",
        owner_user_id: "admin-1",
        name: "Admin private agent",
        visibility: "private",
      },
    ]);
    const metadataClient = { listAgents } as unknown as MetadataClient;

    const result = await listAccessibleAgentsForTeam(
      metadataClient,
      "team-1",
      "member-1",
    );

    expect(listAgents).toHaveBeenCalledWith("team-1");
    expect(result.map((agent) => agent.agent_id)).toEqual([
      "agent-owned-private",
      "agent-admin-team",
    ]);
  });
});
