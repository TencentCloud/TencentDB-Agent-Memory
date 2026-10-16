/**
 * Pi (earendil-works pi-coding-agent) client adapter.
 *
 * Pi sends OpenAI Chat Completions with plain-string user content and no
 * cache_control markers / fork-sidequery concept — every request is main.
 * Verified via a real Pi subprocess spike (2026-08-21).
 */
import { defaultAdapter } from "./default.js";
import type { AgentAdapter } from "./types.js";

export const PI_BRANCH_HEADER = "x-tdai-memory-branch";

const SAFE_BRANCH_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Keep the post-#1126 identity byte-for-byte when no v1 branch marker is sent.
 * A valid marker scopes only Pi's conversation/session identity; tenant,
 * team, user, agent, and task identity remain unchanged.
 */
export function derivePiSessionId(
  sessionId: string | null,
  branchId: string | undefined,
): string | null {
  if (!sessionId || !branchId || !SAFE_BRANCH_ID.test(branchId)) return sessionId;
  return `${sessionId}-${branchId}`;
}

export function readPiBranchHeader(headers: Record<string, string>): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === PI_BRANCH_HEADER) return value;
  }
  return undefined;
}

export const piAdapter: AgentAdapter = {
  agentKind: "pi",
  classifyRequest() {
    return "main";
  },
  extractUserText(content) {
    if (typeof content === "string") return content.length > 0 ? content : null;
    return defaultAdapter.extractUserText(content);
  },
};
