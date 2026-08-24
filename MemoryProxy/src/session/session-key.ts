/**
 * Session key resolution & conversation freshness check.
 *
 * Shared between handler.ts and anthropicHandler.ts.
 */
import type { Context } from "hono";
import { createHash } from "node:crypto";

/** Extract conversation ID from request headers. Returns null if no valid ID found. */
export function resolveConversationId(c: Context): string | null {
  const id =
    c.req.header("x-conversation-id") ??
    c.req.header("x-session-id") ??
    c.req.header("x-claude-code-session-id") ?? // Claude Code CLI sends this
    c.req.header("x-deepseek-harness-session-id") ?? // dsh (deepseek-harness) CLI/web sends this
    c.req.header("x-chat-id") ??
    c.req.header("x-thread-id") ??
    null;
  return id && id.length > 0 ? id : null;
}

/**
 * Cursor's captured Proxy ingress has no conversation/session header. Build a
 * stable fallback from the account-scoped root `user` plus the earliest
 * content-block user message. Cursor preserves that first real user turn in
 * subsequent history, while a new conversation starts a new prefix.
 */
export function resolveCursorConversationId(body: Record<string, unknown>): string | null {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const userMessages = messages.filter((message) => {
    return Boolean(message && typeof message === "object" && (message as { role?: unknown }).role === "user");
  }) as Array<{ content?: unknown }>;
  const anchor = userMessages.find((message) => Array.isArray(message.content)) ?? userMessages[0];
  if (!anchor || anchor.content == null) return null;

  const account = typeof body.user === "string" ? body.user : "anonymous";
  const digest = createHash("sha256")
    .update(JSON.stringify([account, anchor.content]))
    .digest("hex")
    .slice(0, 32);
  return `cursor-${digest}`;
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
