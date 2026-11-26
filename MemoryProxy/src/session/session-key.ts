/**
 * Session key resolution & conversation freshness check.
 *
 * Shared between handler.ts and anthropicHandler.ts.
 */
import type { Context } from "hono";
import { log } from "../report/log.js";

const SESSION_HEADER_PRIORITY = [
  "x-parent-conversation-id",
  "x-conversation-id",
  "x-session-id",
  "session-id",
  "x-claude-code-session-id",
  "x-deepseek-harness-session-id",
  "x-chat-id",
  "x-thread-id",
] as const;

/** Protocol-agnostic session extraction used by Chat, Anthropic and Responses. */
export function extractSessionId(
  headers: Record<string, string | undefined>,
  body?: Record<string, unknown>,
): string | null {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  for (const key of SESSION_HEADER_PRIORITY) {
    const value = normalized[key]?.trim();
    if (value) return value;
  }
  const metadata = body?.client_metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const value = (metadata as Record<string, unknown>).session_id;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** A missing client session must be stable across requests; never use traceId. */
export function resolveSessionKeyFallback(
  sessionId: string | null | undefined,
  keyId: string,
  context?: { protocol: "anthropic" | "openai" | "responses"; agentSource?: string },
): string {
  const explicit = sessionId?.trim();
  if (explicit) return explicit;

  if (context) {
    log.warn("session_key.fallback", {
      protocol: context.protocol,
      agentSource: context.agentSource ?? "",
      fallbackSource: "key_id",
      message: "no supported session id found; using stable fallback",
    });
  }
  return keyId;
}

/**
 * Extract conversation ID from request headers. Returns null if no valid ID found.
 *
 * ── subagent 会话归一（2026-09-20，修复 WorkBuddy 压缩后无限弹表单循环）──
 * WorkBuddy 助理派生并行 subagent 时，每个 subagent 用**独立的新 x-conversation-id**，
 * 但会带 `x-parent-conversation-id` 指向父（主）会话。若按 subagent 自己的
 * conversation-id 做 session key，会在 session store 里查不到主会话已完成的
 * session-init（initialized 绑定），于是每个 subagent 都被判为"新会话"→ 重弹
 * 「选择 Agent/Task」表单；表单又被 replay 进历史 → 无限循环。
 *
 * 修法：**subagent 请求（带 x-parent-conversation-id）一律用 parent id 作为
 * 会话身份** —— 让 subagent 复用主会话的 session key，天然继承 agent/task/team
 * 绑定，不再触发 session-init。主会话请求无此 header，行为完全不变（零侵入）。
 *
 * 实测证据（opik 2026-09-14 + 本地抓包 2026-09-20）：
 *   主会话   : x-conversation-id=888a1848..  x-parent-conversation-id=(无)  purpose=conversation type=main
 *   subagent : x-conversation-id=01a0bcff..  x-parent-conversation-id=888a1848.. purpose=subagent:general-purpose type=team
 *   → subagent.parent === 主会话.conv，故用 parent 归一到主会话身份。
 */
export function resolveConversationId(
  c: Context,
  body?: Record<string, unknown>,
): string | null {
  const headers: Record<string, string> = {};
  for (const [key, value] of c.req.raw.headers.entries()) headers[key] = value;
  return extractSessionId(headers, body);
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
