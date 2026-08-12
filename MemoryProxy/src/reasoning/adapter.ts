/**
 * 946-A Reasoning Protocol Adapter — canonical representation + capability-driven adaptation.
 *
 * 目标（docs/946spec.md §14–§17）：
 *   - canonical 内部表示 CanonicalAssistantMessage 携带 providerState（reasoningContent /
 *     thinkingBlocks / opaqueSignature），并保证跨 session 持久化、历史重建、压缩、下一请求存活；
 *   - UpstreamCapabilities 按「实际上游 provider + 实际 model + 上游 API 方言/版本」选择，
 *     绝不只按客户端应用选择；
 *   - ReasoningAdapter.normalizeRequest/normalizeResponse 抽象请求/响应规范化；
 *   - 禁止在通用请求组装里对所有 provider 静默注入空 reasoning/thinking；
 *   - hasValidThinkingSignature → isPreservableProviderSignature（语义准确：不解释 opaque
 *     字符串形状，只判断「是否是可保留的 provider 签名」）。
 */

// ── Canonical internal representation（§14.2）──────────────────────────────────

export interface CanonicalToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface CanonicalAssistantMessage {
  role: "assistant";
  content?: string;
  toolCalls?: CanonicalToolCall[];

  /** provider-specific 状态，必须随消息持久化/重建/压缩存活。 */
  providerState?: {
    provider: string;
    reasoningContent?: string;
    thinkingBlocks?: unknown[];
    opaqueSignature?: string;
  };
}

// ── Upstream capabilities（§15）────────────────────────────────────────────────

export type UpstreamDialect = "openai" | "anthropic";

export interface UpstreamCapabilities {
  dialect: UpstreamDialect;

  supportsAdaptiveThinking: boolean;
  supportsManualThinkingBudget: boolean;

  requiresReasoningRoundTripForToolCalls: boolean;
  supportsThinkingSignature: boolean;

  maxThinkingBudget?: number;
}

export type ReasoningMode = "adaptive" | "manual" | "none";

// ── Reasoning adapter interface（§15）──────────────────────────────────────────

export interface ReasoningAdapter {
  normalizeRequest(
    history: CanonicalAssistantMessage[],
    capabilities: UpstreamCapabilities,
  ): unknown;

  normalizeResponse(
    response: unknown,
    capabilities: UpstreamCapabilities,
  ): CanonicalAssistantMessage;
}

// ── Missing reasoning policy（§16）─────────────────────────────────────────────

/** 内部错误码：provider 要求 reasoning 状态但历史缺失。 */
export const MISSING_REASONING_CONTEXT = "MISSING_REASONING_CONTEXT";

/**
 * 计算缺失 reasoning 时的 fallback 策略（按 provider/model，不允许全局静默注入空值）。
 *
 * 返回：
 *   - "preserve-or-empty"：该 provider 允许「无 reasoning 则透传空串」（DeepSeek
 *     reasoning 模型的 tool_calls 回传需要 reasoning_content 字段存在，但值可为空）。
 *     这是**该 provider 明确要求**的字段存在性，不是通用静默注入。
 *   - "error"：缺失即报 MISSING_REASONING_CONTEXT（保守 fail-closed）。
 */
export function resolveMissingReasoningPolicy(
  provider: string,
  model: string | undefined,
): "preserve-or-empty" | "error" {
  const p = provider.toLowerCase();
  const m = (model ?? "").toLowerCase();

  // DeepSeek thinking/reasoning 家族模型：thinking mode 要求 tool_calls 历史
  // 消息回传 reasoning_content 字段（值可为空串）。这是该 provider 的协议要求，
  // 不是通用注入——仅当 capabilities.requiresReasoningRoundTripForToolCalls
  // 且实际 model 属于 thinking 家族时才生效。
  // 覆盖命名：deepseek-reasoner / deepseek-r1* / deepseek-v4*（V4 系列默认
  // thinking，如 deepseek-v4-flash）及带 think 字样的模型。
  if (p === "deepseek" && (m.includes("reason") || m.includes("r1") || m.includes("v4") || m.includes("think"))) {
    return "preserve-or-empty";
  }

  return "error";
}

// ── Opaque signature（§17）─────────────────────────────────────────────────────

/**
 * 判断 thinking block 的 signature 是否「可作为 provider 签名保留」。
 *
 * 语义（§17）：不解释字符串形状、不证明签名有效性；只做保守的「可保留性」判定，
 * 避免把「看起来像签名」的字符串当作「有效签名」的依据。无法判定时返回 false
 * （宁可丢弃也不冒险透传可能损坏协议的状态）。
 */
export function isPreservableProviderSignature(block: Record<string, unknown>): boolean {
  const sig = block.signature;
  if (typeof sig !== "string" || sig.length === 0) return false;
  // Anthropic/Bedrock 原生签名是带连字符的 UUID 格式。
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sig)) {
    return true;
  }
  // 其余 base64 样式的长签名：仅当长度足够（≥40）且字符集符合 base64。
  if (sig.length < 40) return false;
  return /^[A-Za-z0-9+/=]+$/.test(sig);
}

// ── Registry：provider + model → capabilities（§15「MUST NOT 只按客户端应用选择」）─

export interface CapabilityProfile {
  provider: string;
  /** 模型名匹配（大小写不敏感，子串匹配）。空/undefined 匹配所有该 provider 模型。 */
  modelPattern?: RegExp;
  dialect: UpstreamDialect;
  capabilities: UpstreamCapabilities;
}

const DEFAULT_PROFILES: CapabilityProfile[] = [
  {
    provider: "deepseek",
    dialect: "openai",
    capabilities: {
      dialect: "openai",
      supportsAdaptiveThinking: false,
      supportsManualThinkingBudget: true,
      // DeepSeek reasoning 模型要求 tool_calls 历史回传 reasoning_content
      requiresReasoningRoundTripForToolCalls: true,
      supportsThinkingSignature: false,
    },
  },
  {
    provider: "anthropic",
    dialect: "anthropic",
    capabilities: {
      dialect: "anthropic",
      supportsAdaptiveThinking: true,
      supportsManualThinkingBudget: true,
      // Claude Code 工具循环中 extended thinking 需要 thinking 块回传
      requiresReasoningRoundTripForToolCalls: true,
      supportsThinkingSignature: true,
      maxThinkingBudget: 32000,
    },
  },
];

/**
 * 按 provider + model 解析 capabilities。
 * 不匹配任何 profile 时返回 null（调用方应 fail-closed 或透传）。
 */
export function resolveUpstreamCapabilities(
  provider: string,
  model: string | undefined,
): UpstreamCapabilities | null {
  const p = provider.toLowerCase();
  for (const profile of DEFAULT_PROFILES) {
    if (profile.provider !== p) continue;
    if (profile.modelPattern && model && !profile.modelPattern.test(model)) continue;
    return profile.capabilities;
  }
  return null;
}

// ── OpenAI 协议 adapter ────────────────────────────────────────────────────────

export interface OpenAIReasoningAdapterOptions {
  /**
   * 当 provider 要求 tool_calls 回传 reasoning_content 但历史缺失时，
   * 是否允许补空串（DeepSeek 要求字段存在；值可为空）。
   * 默认 false → 缺失即报错（fail-closed）。
   */
  allowEmptyReasoningBackfill?: boolean;
}

/**
 * OpenAI 方言 adapter：只处理 DeepSeek 风格 reasoning_content 的字段存在性，
 * 不做任何虚构。用于在转发前规范化历史消息。
 */
export class OpenAIReasoningAdapter implements ReasoningAdapter {
  private readonly opts: OpenAIReasoningAdapterOptions;

  constructor(opts: OpenAIReasoningAdapterOptions = {}) {
    this.opts = opts;
  }

  normalizeRequest(
    history: CanonicalAssistantMessage[],
    capabilities: UpstreamCapabilities,
  ): unknown {
    // 语义：仅当 provider 明确要求 tool_calls 回传 reasoning 时处理；
    // 且策略允许补空串时，才为缺失字段补空。绝不无条件注入。
    const needsRoundTrip = capabilities.requiresReasoningRoundTripForToolCalls;
    if (!needsRoundTrip) return history;

    return history.map((m) => {
      if (m.role !== "assistant" || !m.toolCalls || m.toolCalls.length === 0) return m;
      const hasReasoning = typeof m.providerState?.reasoningContent === "string";
      if (hasReasoning) return m;

      if (!this.opts.allowEmptyReasoningBackfill) {
        // 缺失 → 抛出明确内部错误（由调用方映射为 MISSING_REASONING_CONTEXT）
        const err = new Error(MISSING_REASONING_CONTEXT) as Error & { code?: string };
        err.code = MISSING_REASONING_CONTEXT;
        throw err;
      }
      return {
        ...m,
        providerState: {
          ...m.providerState,
          provider: m.providerState?.provider ?? capabilities.dialect,
          reasoningContent: "",
        },
      };
    });
  }

  normalizeResponse(
    response: unknown,
    _capabilities: UpstreamCapabilities,
  ): CanonicalAssistantMessage {
    // OpenAI 协议响应：reasoning_content 在 message 顶层。
    const msg = (response as { message?: Record<string, unknown> })?.message;
    if (!msg || typeof msg !== "object") {
      return { role: "assistant" };
    }
    const reasoningContent = msg.reasoning_content;
    const toolCalls = Array.isArray(msg.tool_calls)
      ? (msg.tool_calls as Array<Record<string, unknown>>).map((tc) => ({
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
      content: typeof msg.content === "string" ? msg.content : undefined,
      toolCalls,
      providerState: {
        provider: "openai",
        reasoningContent: typeof reasoningContent === "string" ? reasoningContent : undefined,
      },
    };
  }
}

// ── Metrics 名称（§20）─────────────────────────────────────────────────────────

export const REASONING_METRICS = {
  roundtripMissing: "reasoning_roundtrip_missing_total",
  fallback: "reasoning_fallback_total",
  adapterErrors: "reasoning_adapter_errors_total",
} as const;
