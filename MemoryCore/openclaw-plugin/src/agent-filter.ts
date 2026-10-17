export interface AgentFilterConfig {
  include?: string[];
  exclude?: string[];
}

function normalizedAgentIds(values: string[] | undefined): Set<string> {
  return new Set(
    (values ?? [])
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

/**
 * Decide whether the current OpenClaw runtime agent may use this plugin.
 *
 * Exclusions take precedence. When an include list is configured, contexts
 * without an agent id are denied so they cannot accidentally share the fixed
 * remote team/agent/user isolation configured for another runtime agent.
 */
export function isAgentAllowed(
  runtimeAgentId: string | undefined,
  filter: AgentFilterConfig,
): boolean {
  const include = normalizedAgentIds(filter.include);
  const exclude = normalizedAgentIds(filter.exclude);
  const agentId = runtimeAgentId?.trim();

  if (agentId && exclude.has(agentId)) {
    return false;
  }
  if (include.size > 0) {
    return Boolean(agentId && include.has(agentId));
  }
  return true;
}
