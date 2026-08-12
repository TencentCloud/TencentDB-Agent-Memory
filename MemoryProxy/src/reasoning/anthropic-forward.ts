/**
 * 946-A — Anthropic 协议转发前 thinking 规范化。
 *
 * 语义（docs/946spec.md §16–§17）：
 *   - thinking.type=adaptive 且上游**不支持** adaptive（DeepSeek 兼容层）时，
 *     降级为 enabled（budget_tokens=16000）。这是 fc8804d / patch-proxy-thinking.sh
 *     修复的核心场景：Claude Code 发 adaptive，DeepSeek 兼容层不识别 → 400。
 *   - 含 tool_use 的 assistant 消息缺 thinking 块时补 { type:"thinking", thinking:"" }，
 *     仅当请求处于 thinking 模式（thinking 字段存在）。
 *   - 签名判定使用 isPreservableProviderSignature（不解释签名形状的有效性）。
 */

import { isPreservableProviderSignature } from "./adapter.js";

export interface AnthropicForwardResult {
  body: Record<string, unknown>;
  changed: boolean;
}

/** 判断 provider 是否要求 Anthropic 风格的 thinking 回传。 */
export function requiresAnthropicThinkingRoundTrip(provider: string): boolean {
  return provider.toLowerCase() === "anthropic";
}

/** 降级后的 thinking 配置（DeepSeek 兼容层接受 enabled + budget）。 */
const DOWNGRADED_THINKING = { type: "enabled", budget_tokens: 16000 };

/**
 * 规范化 Anthropic body 的 thinking：
 *   1) thinking.type==="adaptive" 且 supportsAdaptiveThinking=false
 *      → 降级为 { type:"enabled", budget_tokens:16000 }
 *      （DeepSeek 兼容层不支持 adaptive，必须降级，否则上游 400）
 *   2) 请求处于 thinking 模式且含 tool_use 的 assistant 消息缺 thinking 块
 *      → 补 { type:"thinking", thinking:"" }
 *      （Anthropic extended thinking 工具循环要求回传 thinking 块）
 *
 * @param body    原始 body（system/messages/thinking 等）
 * @param provider 实际上游 provider（"anthropic" 才处理）
 * @param supportsAdaptiveThinking 上游是否支持 adaptive thinking
 *        （真 Claude=true → 保留 adaptive；DeepSeek 兼容层=false → 降级 enabled）
 */
export function normalizeAnthropicForward(
  body: Record<string, unknown>,
  provider: string,
  supportsAdaptiveThinking = true,
): AnthropicForwardResult {
  if (!requiresAnthropicThinkingRoundTrip(provider)) {
    return { body, changed: false };
  }

  let changed = false;
  const next: Record<string, unknown> = { ...body };

  const thinking = next.thinking as Record<string, unknown> | undefined;
  const thinkingActive = thinking !== undefined && thinking !== null;
  const isAdaptive = thinkingActive && thinking.type === "adaptive";

  // 1) adaptive + 上游不支持 adaptive → 降级为 enabled（DeepSeek 兼容层场景）
  if (isAdaptive && !supportsAdaptiveThinking) {
    next.thinking = DOWNGRADED_THINKING;
    changed = true;
  }

  // 2) 仅当 thinking 模式激活时，给 tool_use 消息补 thinking 块
  if (thinkingActive && Array.isArray(next.messages)) {
    const messages = next.messages as Record<string, unknown>[];
    const newMessages = messages.map((m) => {
      if (m.role !== "assistant" || !Array.isArray(m.content)) return m;
      const content = m.content as Record<string, unknown>[];
      const hasTool = content.some((b) => b?.type === "tool_use");
      const hasThinking = content.some((b) => b?.type === "thinking" || b?.type === "redacted_thinking");
      if (hasTool && !hasThinking) {
        changed = true;
        return { ...m, content: [{ type: "thinking", thinking: "" }, ...content] };
      }
      return m;
    });
    if (changed) next.messages = newMessages;
  }

  return { body: next, changed };
}

export { isPreservableProviderSignature };
