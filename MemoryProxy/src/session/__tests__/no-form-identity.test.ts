import { describe, expect, it, vi } from "vitest";
import { resolveSoleAccessibleIdentity } from "../no-form-identity.js";

describe("resolveSoleAccessibleIdentity", () => {
  it("selects the only accessible agent", async () => {
    const client = {
      listTeams: vi.fn(async () => [{ team_id: "team-1", name: "Team" }]),
      listAgents: vi.fn(async () => [{
        agent_id: "agent-1",
        team_id: "team-1",
        name: "Agent",
      }]),
    };
    await expect(resolveSoleAccessibleIdentity(client, "user-1"))
      .resolves.toEqual({ teamId: "team-1", agentId: "agent-1" });
  });

  it("does not guess when more than one agent is available", async () => {
    const client = {
      listTeams: vi.fn(async () => [{ team_id: "team-1", name: "Team" }]),
      listAgents: vi.fn(async () => [
        { agent_id: "agent-1", team_id: "team-1", name: "One" },
        { agent_id: "agent-2", team_id: "team-1", name: "Two" },
      ]),
    };
    await expect(resolveSoleAccessibleIdentity(client, "user-1"))
      .resolves.toBeUndefined();
  });
});
