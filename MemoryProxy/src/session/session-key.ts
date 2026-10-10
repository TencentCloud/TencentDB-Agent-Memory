/**
 * Session key resolution & conversation freshness check.
 *
 * Shared between handler.ts and anthropicHandler.ts.
 */
import type { Context } from "hono";

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
export function resolveConversationId(c: Context): string | null {
  // subagent 优先用 parent-conversation-id 归一到父（主）会话身份。
  const parentId = c.req.header("x-parent-conversation-id");
  if (parentId && parentId.length > 0) return parentId;

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
