import { AGENT_KINDS } from "../agent-adapters/types.js";

/**
 * Bridge requests usually carry a bare session ID, while SessionStore uses
 * `${agentSource}:${sessionId}`. Keep the fallback list tied to the runtime
 * agent registry so a newly registered agent cannot be omitted here.
 */
export function sessionKeyCandidates(sessionId: string): string[] {
  if (sessionId.includes(":")) return [sessionId];
  return [sessionId, ...AGENT_KINDS.map((agentSource) => `${agentSource}:${sessionId}`)];
}

/**
 * Resolve an initialized session from L1 using the shared candidate list.
 * Each bridge supplies its own state-to-identity conversion.
 */
export function resolveSessionFromL1<TState, TFields>(
  sessionId: string,
  getState: (key: string) => TState | undefined,
  toFields: (state: TState | undefined, key: string) => TFields | null,
): TFields | null {
  for (const key of sessionKeyCandidates(sessionId)) {
    const fields = toFields(getState(key), key);
    if (fields) return fields;
  }
  return null;
}
