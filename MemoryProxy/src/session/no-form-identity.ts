import type { MetadataClient } from "../meta/client.js";
import type { PresetIdentity } from "./preset.js";

/**
 * Pick an identity without prompting only when the authenticated user has one
 * unambiguous agent across all accessible teams. Task remains optional so
 * recall keeps the normal broad/default-task semantics.
 */
export async function resolveSoleAccessibleIdentity(
  metadataClient: Pick<MetadataClient, "listTeams" | "listAgents">,
  userId: string,
): Promise<PresetIdentity | undefined> {
  if (!userId) return undefined;
  const teams = await metadataClient.listTeams(userId);
  let selected: PresetIdentity | undefined;

  for (const team of teams) {
    const agents = await metadataClient.listAgents(team.team_id, userId);
    for (const agent of agents) {
      if (selected) return undefined;
      selected = { teamId: team.team_id, agentId: agent.agent_id };
    }
  }
  return selected;
}
