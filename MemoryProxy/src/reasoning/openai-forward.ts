/**
 * 946-A — OpenAI 协议转发前 reasoning 规范化。
 *
 * 语义：仅当 capability 明确要求（requiresReasoningRoundTripForToolCalls）且
 * provider 策略允许补空串时，才为缺失的 reasoning_content 字段补空。
 * 这不是通用静默注入——由 resolveMissingReasoningPolicy 按 provider+model 判定。
 *
 * 返回 { body, changed, blocked }：
 *   - changed: 是否修改了消息（用于日志）
 *   - blocked: 是否存在「provider 要求但策略禁止补空」的缺失（调用方应拒绝转发）
 */

import {
  OpenAIReasoningAdapter,
  resolveMissingReasoningPolicy,
  type CanonicalAssistantMessage,
} from "./adapter.js";

export interface OpenAiForwardResult {
  body: Record<string, unknown>;
  changed: boolean;
  blocked: boolean;
}

function toCanonical(raw: Record<string, unknown>): CanonicalAssistantMessage {
  const toolCalls = Array.isArray(raw.tool_calls)
    ? (raw.tool_calls as Array<Record<string, unknown>>).map((tc) => ({
        id: typeof tc.id === "string" ? tc.id : "",
        name: typeof (tc.function as Record<string, unknown> | undefined)?.name === "string"
          ? (tc.function as Record<string, unknown>).name as string
          : "",
        arguments: typeof (tc.function as Record<string, unknown> | undefined)?.arguments === "string"
          ? (tc.function as Record<string, unknown>).arguments as string
          : "",
      }))
    : undefined;
  return {
    role: "assistant",
    content: typeof raw.content === "string" ? raw.content : undefined,
    toolCalls,
    providerState: {
      provider: "openai",
      reasoningContent: typeof raw.reasoning_content === "string" ? raw.reasoning_content : undefined,
    },
  };
}

function fromCanonical(m: CanonicalAssistantMessage): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (m.content !== undefined) out.content = m.content;
  if (m.toolCalls && m.toolCalls.length > 0) {
    out.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  if (m.providerState?.reasoningContent !== undefined) {
    out.reasoning_content = m.providerState.reasoningContent;
  }
  return out;
}

/**
 * 在转发前规范化 OpenAI 历史消息的 reasoning_content 字段存在性。
 *
 * @param body   原始请求体（含 messages）
 * @param provider 实际上游 provider（如 "deepseek"）
 * @param model  实际 model id（用于判定 reasoning 模型）
 */
export function normalizeOpenAiForward(
  body: Record<string, unknown>,
  provider: string,
  model: string | undefined,
): OpenAiForwardResult {
  const messages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : null;
  if (!messages) return { body, changed: false, blocked: false };

  // 仅处理带 tool_calls 的 assistant 消息（reasoning 回传只在工具循环中相关）
  const assistantWithTools = messages.filter(
    (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && (m.tool_calls as unknown[]).length > 0,
  );
  if (assistantWithTools.length === 0) return { body, changed: false, blocked: false };

  // 仅当 provider 明确要求 reasoning 回传（DeepSeek reasoning 模型）时才处理；
  // 其它 provider（openai/其它）透传，不做任何注入、也绝不拒绝转发。
  const policy = resolveMissingReasoningPolicy(provider, model);
  if (policy !== "preserve-or-empty") return { body, changed: false, blocked: false };

  const adapter = new OpenAIReasoningAdapter({
    allowEmptyReasoningBackfill: true, // policy 已确认 preserve-or-empty
  });

  const canonical = assistantWithTools.map(toCanonical);
  const normalized = adapter.normalizeRequest(canonical, {
    dialect: "openai",
    supportsAdaptiveThinking: false,
    supportsManualThinkingBudget: true,
    requiresReasoningRoundTripForToolCalls: true,
    supportsThinkingSignature: false,
  }) as CanonicalAssistantMessage[];

  const newMessages = messages.map((m) => {
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls) || (m.tool_calls as unknown[]).length === 0) {
      return m;
    }
    const idx = assistantWithTools.indexOf(m);
    const norm = idx >= 0 ? normalized[idx] : undefined;
    if (!norm) return m;
    const rebuilt = fromCanonical(norm);
    // 仅在确实补了空 reasoning_content 时标记 changed
    if (typeof m.reasoning_content === "undefined" && rebuilt.reasoning_content === "") {
      return { ...m, ...rebuilt };
    }
    return m;
  });

  const changed = JSON.stringify(newMessages) !== JSON.stringify(messages);
  return { body: { ...body, messages: newMessages }, changed, blocked: false };
}
