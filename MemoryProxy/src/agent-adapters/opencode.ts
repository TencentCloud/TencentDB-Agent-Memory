/**
 * opencode 客户端适配器。
 *
 * OpenCode 1.x uses `@ai-sdk/openai-compatible`; OpenCode 2.0 uses
 * `@opencode/ai/providers/openai-compatible`. Both reach this adapter through
 * OpenAI Chat Completions. Responses/Anthropic runtimes are separate paths.
 *
 * # 与已有 openai-chat 客户端的差异
 *
 *   - CodeBuddy: content 恒字符串，塞 `<user_query>` / `<additional_data>`
 *     / `<user_info>` wrapper —— 需走 `extractUserQueryText` 剥离
 *   - dsh: content 恒字符串，**裸文本**无 wrapper —— 直接返回
 *   - OpenCode 2.0.18 本地 CLI 实测：主请求的最后一条 user content 是裸文本；
 *     同轮标题生成请求使用同一端点，但 system prompt 有固定标题生成标记。
 *
 *   保守策略：走 `extractUserQueryText`。
 *   —— 该函数对"无 wrapper 的纯字符串"会原样返回，对未来 opencode 若真
 *      塞了 wrapper 也能吃下（forward-compatible）；两种形态零回归。
 *
 * # 两个适配点
 *   - `classifyRequest`: OpenCode 2.0 的标题生成请求为 auxiliary
 *   - `extractUserText`: 字符串或文本块数组 → 合并后剥离非用户上下文
 *
 * Keep a dedicated adapter so OpenCode request classification and telemetry
 * can evolve independently from CodeBuddy.
 */

import { extractUserQueryText } from "../common/user-query-extractor.js";
import { TOOLCALL_PREFIX } from "../session/opencode/form.js";
import { defaultAdapter } from "./default.js";
import type { AgentAdapter } from "./types.js";

// ── Session-init 表单回执识别（L0 抽取用） ─────────────────────────────────
//
// opencode `question` 工具回答回执的固定开头（见 session/opencode/form.ts 头注释：
// "User has answered your questions: \"问题1\"=\"答案1\""）。
const FORM_ANSWER_PREFIX = "User has answered your questions:";

/**
 * proxy 伪造的 session-init 表单 tool_call 消息（assistant）。
 * 判据：tool_calls 非空、无文本 content、且**所有** tool_call id 都是
 * `call_oc_session_init_` 前缀（混合任何非表单 tool_call 即视为真实消息，
 * 避免把真实 assistant 回合误判成表单回执）。
 */
function isSessionInitFormAssistant(msg: Record<string, unknown> | undefined): boolean {
  if (msg?.role !== "assistant") return false;
  const content = msg.content;
  if (typeof content === "string" && content.trim() !== "") return false;
  if (Array.isArray(content) && content.length > 0) return false;
  const toolCalls = msg.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return false;
  return toolCalls.every((tc) => {
    const id = (tc as Record<string, unknown>)?.id;
    return typeof id === "string" && id.startsWith(TOOLCALL_PREFIX);
  });
}

/**
 * session-init 表单回答回执（tool）。
 * 判据：role=tool 且 content 以固定开头（opencode `question` 工具的回传格式）。
 */
function isSessionInitFormAnswer(msg: Record<string, unknown> | undefined): boolean {
  return msg?.role === "tool" && typeof msg.content === "string"
    && msg.content.startsWith(FORM_ANSWER_PREFIX);
}

export const opencodeAdapter: AgentAdapter = {
  agentKind: "opencode",

  classifyRequest(body) {
    // OpenCode 2.0.18 sends title generation to the same chat/completions
    // endpoint as the main conversation. Its first system message carries
    // this distinct marker; keep that request out of memory/session effects.
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const first = messages[0] as Record<string, unknown> | undefined;
    if (first?.role === "system" && typeof first.content === "string"
      && first.content.startsWith("You are a title generator. You output ONLY a thread title.")) {
      return "auxiliary";
    }
    return "main";
  },

  extractUserText(content) {
    // Chat Completions currently sends a string; content-blocks are also
    // accepted without letting injected text bypass the same cleanup.
    const raw = typeof content === "string" ? content : defaultAdapter.extractUserText(content);
    if (!raw) return null;
    const extracted = extractUserQueryText(raw);
    return extracted.length > 0 ? extracted : null;
  },

  /**
   * L0 turn-input extraction — 从请求消息里定位"本轮用户真实输入"。
   *
   * # 背景（2026-10-26 实抓回归）
   * 58e4c55（#1552，修 #1551 的写放大/误提取）把判据收紧为「最后一条必须是
   * user」。但 session-init 表单被回答后，OpenCode 会把
   * [assistant(表单 tool_call), tool(表单回答)] 追加在用户消息**之后**重发，
   * 使该回合首个转发请求以 tool 结尾 → `tdaiUserMessage=null` → 整回合 L0
   * 静默丢失（write-l0 从不打印，hub 各层全空）。
   *
   * # 修法（兼容 #1621 的防放大语义）
   * 从后往前扫：跳过 session-init 表单回执（assistant 表单 tool_call +
   * tool 回答），落在 user 上 → 抽取；落在任何**非表单**消息（真实工具循环
   * 尾部 / assistant / 空）上 → 返回 ""（不写，避免回到 #1551 的每请求重写）。
   *
   * 返回 "" 表示"本轮不应写 L0"；返回非空文本即本轮用户输入。
   */
  extractL0UserQuery(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as Record<string, unknown> | undefined;
      if (isSessionInitFormAssistant(msg) || isSessionInitFormAnswer(msg)) continue;
      if (msg?.role === "user") {
        return this.extractUserText(msg.content) ?? "";
      }
      // 真实 tool 结果 / assistant 回合 / 其他角色 → 本轮不是"用户刚发言"
      return "";
    }
    return "";
  },
};
