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
import { defaultAdapter } from "./default.js";
import type { AgentAdapter } from "./types.js";

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
};
