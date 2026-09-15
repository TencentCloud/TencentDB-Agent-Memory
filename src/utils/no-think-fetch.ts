/**
 * Multi-strategy fetch wrapper for disabling thinking/reasoning across
 * different inference engines and model providers.
 *
 * Each strategy injects provider-specific fields into chat-completion
 * request bodies. Non-chat requests (embeddings, etc.) pass through
 * unchanged.
 *
 * Strategies:
 * - `"vllm"`:      vLLM / SGLang — `chat_template_kwargs.enable_thinking = false`
 * - `"deepseek"`:  DeepSeek V3-series API — top-level `enable_thinking: false`
 * - `"deepseek-v4"`: DeepSeek V4 hybrid models (e.g. deepseek-v4-flash) — they
 *                  ignore `enable_thinking`; honor `thinking: { type: "disabled" }`
 * - `"dashscope"`: Alibaba DashScope (Qwen) — top-level `enable_thinking: false`
 * - `"openai"`:    OpenAI o-series — `reasoning_effort: "low"` (cannot fully disable)
 * - `"anthropic"`: Anthropic Claude — `thinking: { type: "disabled" }`
 * - `"kimi"`:      Kimi (Moonshot) — `thinking: { type: "disabled" }`
 * - `"gemini"`:    Google Gemini — `thinking_config: { thinking_budget: 0 }`
 */

// ─── Type & validation ────────────────────────────────────────────────────────

export type DisableThinkingStrategy =
  | false
  | "vllm"
  | "deepseek"
  | "deepseek-v4"
  | "dashscope"
  | "openai"
  | "anthropic"
  | "kimi"
  | "gemini";

export const VALID_DISABLE_THINKING_STRATEGIES: readonly DisableThinkingStrategy[] = [
  false, "vllm", "deepseek", "deepseek-v4", "dashscope", "openai", "anthropic", "kimi", "gemini",
] as const;

/** Check if a value is a valid DisableThinkingStrategy. */
export function isValidDisableThinkingStrategy(value: unknown): value is DisableThinkingStrategy {
  return (VALID_DISABLE_THINKING_STRATEGIES as readonly unknown[]).includes(value);
}

/**
 * Normalize a raw boolean-or-string config value into a DisableThinkingStrategy.
 *
 *   true  → "vllm" (shorthand for the most common self-hosted scenario)
 *   false / undefined → false
 *
 * Unknown string values fall back to false with a console warning.
 */
export function normalizeDisableThinking(raw: boolean | string | undefined): DisableThinkingStrategy {
  if (raw === undefined || raw === false) return false;
  if (raw === true) return "vllm";
  // raw is a string
  if (isValidDisableThinkingStrategy(raw)) return raw;
  console.warn(
    `[memory-tdai] Unknown disableThinking strategy "${raw}", ` +
    `valid values: false, true, "vllm", "deepseek", "deepseek-v4", "dashscope", "openai", "anthropic", "kimi", "gemini". ` +
    `Thinking will NOT be disabled.`,
  );
  return false;
}

// ─── Per-provider body transformers ───────────────────────────────────────────

function applyVllm(body: Record<string, unknown>): void {
  const existing = body.chat_template_kwargs;
  const base = (existing && typeof existing === "object" && !Array.isArray(existing))
    ? existing as Record<string, unknown>
    : {};
  body.chat_template_kwargs = { ...base, enable_thinking: false };
}

function applyDeepSeek(body: Record<string, unknown>): void {
  body.enable_thinking = false;
}

// DeepSeek V4 hybrid models (deepseek-v4-flash, …) ignore the top-level
// `enable_thinking` flag the V3 API used; they only suppress reasoning when
// given the object form `thinking: { type: "disabled" }` (verified 2026-06).
function applyDeepSeekV4(body: Record<string, unknown>): void {
  body.thinking = { type: "disabled" };
}

function applyDashScope(body: Record<string, unknown>): void {
  body.enable_thinking = false;
}

function applyOpenAI(body: Record<string, unknown>): void {
  body.reasoning_effort = "low";
}

function applyAnthropic(body: Record<string, unknown>): void {
  body.thinking = { type: "disabled" };
}

function applyGemini(body: Record<string, unknown>): void {
  body.thinking_config = { thinking_budget: 0 };
}

const STRATEGY_TRANSFORMERS: Record<
  Exclude<DisableThinkingStrategy, false>,
  (body: Record<string, unknown>) => void
> = {
  vllm: applyVllm,
  deepseek: applyDeepSeek,
  "deepseek-v4": applyDeepSeekV4,
  dashscope: applyDashScope,
  openai: applyOpenAI,
  anthropic: applyAnthropic,
  kimi: applyAnthropic,
  gemini: applyGemini,
};

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a fetch wrapper that injects provider-specific thinking-disabling
 * fields into chat-completion request bodies.
 *
 * When `strategy` is `false`, returns `globalThis.fetch` directly (no wrapper).
 *
 * Only requests with a `messages` array in the body are modified — embedding
 * and other non-chat requests pass through unchanged.
 */
export function createNoThinkFetch(strategy: DisableThinkingStrategy = false): typeof globalThis.fetch {
  if (strategy === false) return globalThis.fetch;

  const transform = STRATEGY_TRANSFORMERS[strategy];
  if (!transform) return globalThis.fetch; // defensive: unknown strategy → passthrough

  return (async (input, init) => {
    if (init && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body);
        if (body && Array.isArray(body.messages)) {
          transform(body);
          init = { ...init, body: JSON.stringify(body) };
        }
      } catch {
        // non-JSON body — forward unchanged
      }
    }
    return globalThis.fetch(input, init);
  }) as typeof globalThis.fetch;
}
