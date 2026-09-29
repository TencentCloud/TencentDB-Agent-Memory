/**
 * Session-key candidate generation for the reverse-proxy bridges.
 *
 * Session state is stored in the in-memory `SessionStore` under the composite
 * key `${agentSource}:${sessionId}` (see `session/store.ts#hydrateFromDb` and
 * the `*:init.ts` entry sites). The bridge curl templates, however, only carry
 * a *bare* session id (e.g. `x-conversation-id: conv-abc`), so the bridges must
 * probe the store for every plausible prefixed key.
 *
 * Historically each bridge hard-coded the probe list as `[codebuddy, claude-code]`.
 * When new clients were added (`workbuddy`, `pi`, `codex`, `dsh`, `opencode`)
 * their keys were never probed → L1 miss → the spaceId-dependent L2 fallback
 * could not recover → the request 401'd. This module owns the probe list so the
 * bridges stay in lockstep with the adapter registry (`KNOWN_AGENT_KINDS`).
 */

import { KNOWN_AGENT_KINDS } from "../agent-adapters/index.js";

/**
 * Produce the ordered list of composite keys to try in the in-memory L1 store
 * for a given (usually bare) session id.
 *
 * - If `sessionId` already contains a `:` it is treated as an already-composite
 *   key and returned as-is (single candidate).
 * - Otherwise the bare id is tried first, then `${agentSource}:${sessionId}` for
 *   every known agent source (value domain of `AgentKind`, minus the `unknown`
 *   fallback).
 */
export function sessionKeyCandidates(sessionId: string): string[] {
  if (sessionId.includes(":")) return [sessionId];
  return [sessionId, ...KNOWN_AGENT_KINDS.map((k) => `${k}:${sessionId}`)];
}
