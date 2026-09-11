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
    c.req.header("x-deepseek-harness-session-id") ?? // dsh (deepseek-harness) CLI/web sends this
    // dsh via pi-ai adapter with `compat.sendSessionAffinityHeaders: true` sends this
    // (pi-ai openai-format; same sessionId value as x-deepseek-harness-session-id).
    // issue TencentCloud/TencentDB-Agent-Memory#1179
    c.req.header("x-session-affinity") ??
    c.req.header("x-chat-id") ??
    c.req.header("x-thread-id") ??
    null;
  return id && id.length > 0 ? id : null;
}

/**
 * dsh (deepseek-harness) 走 pi-ai / 其它 OpenAI-compatible 通道时，请求不携带
 * **任何**会话头（只有 llm-deepseek 适配器挂 x-deepseek-harness-session-id）——
 * 此时 resolveConversationId 返回 null，session-init 表单 + 注入管线被静默跳过
 * （issue TencentCloud/TencentDB-Agent-Memory#1179）。
 *
 * 该函数返回应使用的兜底会话标识（keyId 派生的稳定 sessionKey）；其它客户端
 * 保持既有行为（无会话头 → 跳过），避免误伤没有交互式 form UI 的通道。
 *
 * 注意：兜底会话状态按 `dsh:<keyId>` 共享 —— 同一 user key 的所有 dsh pi-ai
 * 会话共享一次 Team/Agent 选择（该通道无更强的 per-conversation 标识）。
 */
export function resolveDshFallbackConversationId(
  agentSource: string,
  sessionKey: string,
): string | null {
  if (agentSource !== "dsh") return null;
  return sessionKey && sessionKey.length > 0 ? sessionKey : null;
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
