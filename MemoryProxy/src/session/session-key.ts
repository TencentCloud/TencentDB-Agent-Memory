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
 * Extract a conversation ID embedded in the request body's system/user prompt.
 *
 * Some clients (e.g. CodeBuddy 4.10.2~4.10.4) do not send a conversation header,
 * so the ID is injected into the prompt by the SessionStart hook instead. The
 * hook (deploy/global-images/hooks/session_start.py) writes it into the first
 * user message's `<additional_data>` block, so both system and user messages
 * are scanned. Prefers the tagged format, falls back to generic field names.
 */
export function extractConversationIdFromPrompt(
  body: Record<string, unknown> | undefined,
): string | null {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) return null;

  let text = "";
  for (const m of body.messages as Array<{ role?: string; content?: unknown }>) {
    const role = m.role ?? "";
    if (role !== "system" && role !== "user") continue;
    let content = "";
    if (typeof m.content === "string") {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = (m.content as Array<{ type?: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
    }
    if (content) text += content + "\n";
  }
  if (!text) return null;

  // Tagged marker injected by the hook takes precedence.
  const tagged = text.match(
    /\[tdai-proxy-session\]\s*conversation_id:\s*([A-Za-z0-9._-]{6,})/i,
  );
  if (tagged && tagged[1]) return tagged[1];

  // Fall back to generic conversation/session id field names.
  const generic = text.match(
    /(?:conversation|session|chat)[_\s-]?id["\s:=]+([A-Za-z0-9._-]{6,})/i,
  );
  if (generic && generic[1]) return generic[1];

  return null;
}

/**
 * Strip the injected conversation marker from messages in place.
 *
 * The marker is only metadata for conversation identification; it must not be
 * forwarded to the upstream LLM nor persist into memory. Idempotent, and only
 * matches the exact tagged format so user input is never touched.
 */
export function stripConversationMarker(messages: Array<Record<string, unknown>> | undefined): void {
  if (!messages || !Array.isArray(messages)) return;
  const re = /\[tdai-proxy-session\]\s*conversation_id:\s*[A-Za-z0-9._-]{6,}\s*/gi;
  for (const m of messages) {
    if (typeof m.content !== "string" || !m.content.includes("[tdai-proxy-session]")) continue;
    m.content = m.content.replace(re, "");
  }
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
