/**
 * Session key resolution & conversation freshness check.
 *
 * Shared between handler.ts and anthropicHandler.ts.
 */
import type { Context } from "hono";

/** Extract conversation ID from request headers. Returns null if no valid ID found. */
export function resolveConversationId(c: Context): string | null {
  const id =
    c.req.header("x-conversation-id") ??
    c.req.header("x-session-id") ??
    c.req.header("x-claude-code-session-id") ?? // Claude Code CLI sends this
    c.req.header("x-chat-id") ??
    c.req.header("x-thread-id") ??
    null;
  return id && id.length > 0 ? id : null;
}

/**
 * Return the SessionStore keys that may correspond to a bridge header.
 *
 * Main proxy requests store composite keys as `${agentSource}:${sessionId}`,
 * while bridge calls only carry the bare conversation ID. Keep the exact key
 * first, then try the adapter prefixes used by the v2 proxy deployment.
 */
export function sessionKeyCandidates(sessionKey: string): string[] {
  if (sessionKey.includes(":")) return [sessionKey];
  return [
    sessionKey,
    `codebuddy:${sessionKey}`,
    `claude-code:${sessionKey}`,
    `hermes:${sessionKey}`,
  ];
}

/** Check whether the messages look like a fresh conversation (at most 1 user message, no assistant/tool). */
export function isFreshConversation(
  messages: Array<{ role?: string }>,
): boolean {
  let userCount = 0;
  for (const m of messages) {
    const role = m.role ?? "";
    if (role === "assistant" || role === "tool") return false;
    if (role === "user") userCount++;
    if (userCount > 1) return false;
  }
  return userCount <= 1;
}
