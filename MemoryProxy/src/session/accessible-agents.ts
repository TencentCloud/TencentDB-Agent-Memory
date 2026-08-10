import type { AgentEntity, MetadataClient } from "../meta/client.js";

/**
 * List agents a team member may select during session initialization.
 *
 * The metadata list endpoint can filter by owner, but that would hide agents
 * shared by another team member. Query the team once, then retain the caller's
 * own agents and agents explicitly shared with the team.
 */
export async function listAccessibleAgentsForTeam(
  metadataClient: Pick<MetadataClient, "listAgents">,
  teamId: string,
  userId: string,
): Promise<AgentEntity[]> {
  const agents = await metadataClient.listAgents(teamId);
  return agents.filter(
    (agent) =>
      agent.owner_user_id === userId || agent.visibility === "team",
  );
}
