/**
 * Session key resolution & conversation freshness check.
 *
 * Shared between handler.ts and anthropicHandler.ts.
 */
import { createHash } from "node:crypto";
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
 * 兜底策略（review P1 修正）：
 * - 旧实现直接用 keyId 派生的稳定 sessionKey 当会话标识 → 同一 user key 的
 *   **所有** dsh 会话共享一次 Team/Agent 选择、session identity、L0 记忆分组，
 *   并发会话之间会互相污染（两个不同会话拿到同一个 session id）。
 * - 现改为从请求 body 派生**稳定的 per-conversation** 标识：锚定第一条
 *   `role=user` 消息的文本做哈希。同一会话的所有轮次（messages 只增不改，
 *   首条用户消息不变）→ 标识不变；不同会话首条用户消息不同 → 标识不同，
 *   session-init 状态 / 记忆分组互不串线。
 * - **fail-closed**：body 里派生不出 per-conversation 标识（没有 user 消息、
 *   或首条 user 消息无文本）时返回 null，调用方应**跳过**该请求的
 *   session-init / 记忆注入，而不是静默合并进 `dsh:<keyId>` 共享会话。
 *
 * 其它客户端保持既有行为（无会话头 → 跳过），避免误伤没有交互式 form UI
 * 的通道。需要更强隔离时，仍建议客户端携带会话头（`x-session-affinity` /
 * `x-deepseek-harness-session-id`），header 恒优先于 body 派生。
 */
export function resolveDshFallbackConversationId(agentSource: string, messages: unknown): string | null {
  if (agentSource !== "dsh") return null;
  return deriveConversationIdFromMessages(messages);
}

/**
 * 从会话 body 派生稳定的 per-conversation 标识。
 *
 * 锚点 = 第一条 `role=user` 消息的文本（dsh 主对话里即用户的首条真实输入；
 * 其后的 `<system-reminder>` / `runtime context` / `<available_skills>` user
 * 消息不影响锚点）。文本 → `sha1` 前 16 位 hex，加 `dsh-der-` 前缀，
 * 与 header 来源的会话 id（如 `session-<uuid>`）可区分。
 *
 * 派生失败（messages 非数组 / 无 user 消息 / 首条 user 消息无文本）返回
 * null —— 调用方据此 fail-closed。
 */
export function deriveConversationIdFromMessages(messages: unknown): string | null {
  // 容错：旧调用方若传入纯字符串（历史签名里的 sessionKey 参数），按锚点文本
  // 直接派生，保持函数对任意入参都有确定结果。
  if (typeof messages === "string") {
    const t = messages.trim();
    return t ? hashAnchor(t) : null;
  }
  if (!Array.isArray(messages)) return null;
  for (const m of messages) {
    if (m && m.role === "user") {
      const text = contentToText(m.content);
      if (!text) return null;
      return hashAnchor(text);
    }
  }
  return null;
}

function hashAnchor(text: string): string {
  const digest = createHash("sha1").update(text, "utf8").digest("hex").slice(0, 16);
  return `dsh-der-${digest}`;
}

/** content 可能是纯字符串（dsh 现状）或 parts 数组（openai parts 形态），统一取文本。 */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content) {
      if (typeof p === "string") parts.push(p);
      else if (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string") {
        parts.push((p as { text: string }).text);
      }
    }
    return parts.join("\n").trim();
  }
  return "";
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
