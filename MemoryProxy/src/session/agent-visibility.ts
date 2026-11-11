import type { AgentEntity } from "../meta/client.js";

/**
 * Session initialization may use agents owned by the caller and agents the
 * team explicitly shared. Other private/restricted agents stay hidden.
 */
export function isAgentVisibleToSessionUser(
  agent: AgentEntity,
  userId: string,
): boolean {
  return agent.owner_user_id === userId || agent.visibility === "team";
}

export function visibleSessionAgents(
  agents: AgentEntity[],
  userId: string,
): AgentEntity[] {
  return agents.filter((agent) => isAgentVisibleToSessionUser(agent, userId));
}
