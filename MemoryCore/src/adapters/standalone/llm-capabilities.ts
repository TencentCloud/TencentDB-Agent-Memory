import { tiktokenCount } from "../../offload/context-token-tracker.js";

export type StandaloneLLMBackend = "openai-compatible" | "ollama" | "llama.cpp";

export interface StandaloneLLMReasoningConfig {
  /** Explicitly enable/disable thinking. Omit to preserve backend defaults. */
  enabled?: boolean;
  /** OpenAI/Ollama reasoning effort (for example: none, low, medium, high). */
  effort?: string;
  /** llama.cpp reasoning parser/format (for example: deepseek or none). */
  format?: string;
}

export interface StandaloneLLMStartupProbeConfig {
  /** Probe the model/backend during gateway startup. Defaults on for local backends. */
  enabled?: boolean;
  /** Refuse gateway startup rather than expose degraded health. */
  strict?: boolean;
  /** Probe timeout in milliseconds. */
  timeoutMs?: number;
}

export interface StandaloneLLMCapabilityConfig {
  backend?: StandaloneLLMBackend;
  /** Operator-configured model context window. */
  contextWindow?: number;
  /** Optional tighter prompt budget; defaults to contextWindow - maxTokens. */
  inputBudgetTokens?: number;
  /** Explicit, provider-specific fields merged into /chat/completions requests. */
  extraBody?: Record<string, unknown>;
  reasoning?: StandaloneLLMReasoningConfig;
  startupProbe?: StandaloneLLMStartupProbeConfig;
  /** Populated from a successful startup probe; not read from config files. */
  effectiveContextWindow?: number;
}

export interface LLMCapabilityStatus {
  state: "ready" | "degraded" | "unchecked";
  backend: StandaloneLLMBackend;
  model: string;
  configuredContextWindow?: number;
  effectiveContextWindow?: number;
  configuredInputBudgetTokens?: number;
  effectiveInputBudgetTokens?: number;
  reasoning: {
    enabled?: boolean;
    effort?: string;
    format?: string;
  };
  /** Names only: values may contain private provider configuration. */
  extraBodyKeys: string[];
  detail: string;
}

export interface LLMProbeConfig extends StandaloneLLMCapabilityConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
}

const RESERVED_CHAT_FIELDS = new Set(["model", "messages", "stream"]);

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nativeRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function safeExtraBody(config: StandaloneLLMCapabilityConfig): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config.extraBody ?? {})) {
    if (!RESERVED_CHAT_FIELDS.has(key)) result[key] = value;
  }
  return result;
}

/** Apply only explicitly configured compatible-backend options to a chat request. */
export function applyLlmRequestOptions(
  body: Record<string, unknown>,
  config: StandaloneLLMCapabilityConfig,
): Record<string, unknown> {
  const result = { ...body, ...safeExtraBody(config) };
  const backend = config.backend ?? "openai-compatible";
  const reasoning = config.reasoning;

  if (backend === "llama.cpp") {
    if (reasoning?.enabled !== undefined) {
      const existing = result.chat_template_kwargs;
      result.chat_template_kwargs = {
        ...(existing && typeof existing === "object" && !Array.isArray(existing)
          ? existing as Record<string, unknown>
          : {}),
        enable_thinking: reasoning.enabled,
      };
    }
    if (reasoning?.format) result.reasoning_format = reasoning.format;
  } else if (reasoning?.effort) {
    result.reasoning_effort = reasoning.effort;
  } else if (backend === "ollama" && reasoning?.enabled === false) {
    // Ollama's OpenAI-compatible endpoint documents "none" as the disable value.
    result.reasoning_effort = "none";
  }

  return result;
}

/** Fetch middleware used by the AI SDK compatible provider. */
export function createLlmFetch(
  config: StandaloneLLMCapabilityConfig,
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    if (!url.match(/\/chat\/completions(?:\?|$)/) || typeof init?.body !== "string") {
      return fetchImpl(input, init);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(init.body);
    } catch {
      return fetchImpl(input, init);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fetchImpl(input, init);
    }
    return fetchImpl(input, {
      ...init,
      body: JSON.stringify(applyLlmRequestOptions(parsed as Record<string, unknown>, config)),
    });
  }) as typeof fetch;
}

function effectiveBudget(config: LLMProbeConfig, effectiveContextWindow?: number): number | undefined {
  const explicit = positiveInt(config.inputBudgetTokens);
  if (explicit) return explicit;
  const context = effectiveContextWindow ?? positiveInt(config.contextWindow);
  return context ? Math.max(1, context - (positiveInt(config.maxTokens) ?? 4096)) : undefined;
}

function contextConfigurationError(
  config: LLMProbeConfig,
  effectiveContextWindow?: number,
): string | undefined {
  const context = effectiveContextWindow ?? positiveInt(config.contextWindow);
  const maxTokens = positiveInt(config.maxTokens) ?? 4096;
  if (context && !positiveInt(config.inputBudgetTokens) && maxTokens >= context) {
    return `maxTokens ${maxTokens} leaves no input budget in context window ${context}`;
  }
  const explicitBudget = positiveInt(config.inputBudgetTokens);
  if (context && explicitBudget && explicitBudget + maxTokens > context) {
    return `inputBudgetTokens ${explicitBudget} + maxTokens ${maxTokens} exceeds context window ${context}`;
  }
  return undefined;
}

function baseStatus(config: LLMProbeConfig): LLMCapabilityStatus {
  const effectiveContext = positiveInt(config.effectiveContextWindow);
  return {
    state: "unchecked",
    backend: config.backend ?? "openai-compatible",
    model: config.model,
    configuredContextWindow: positiveInt(config.contextWindow),
    effectiveContextWindow: effectiveContext,
    configuredInputBudgetTokens: positiveInt(config.inputBudgetTokens),
    effectiveInputBudgetTokens: effectiveBudget(config, effectiveContext),
    reasoning: {
      enabled: config.reasoning?.enabled,
      effort: config.reasoning?.effort,
      format: config.reasoning?.format,
    },
    extraBodyKeys: Object.keys(safeExtraBody(config)).sort(),
    detail: "startup capability probe disabled",
  };
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<{ response: Response; json?: Record<string, unknown>; text: string }> {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let json: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed;
  } catch {
    // The status and a bounded, redacted diagnostic are enough below.
  }
  return { response, json, text };
}

function boundedDiagnostic(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").slice(0, 240);
}

function parseOllamaContext(json: Record<string, unknown> | undefined): number | undefined {
  if (!json) return undefined;
  const parameters = typeof json.parameters === "string" ? json.parameters : "";
  const paramMatch = parameters.match(/(?:^|\n)\s*num_ctx\s+(\d+)/);
  if (paramMatch) return positiveInt(Number(paramMatch[1]));
  const modelInfo = json.model_info;
  if (modelInfo && typeof modelInfo === "object" && !Array.isArray(modelInfo)) {
    for (const [key, value] of Object.entries(modelInfo as Record<string, unknown>)) {
      if (key.endsWith(".context_length")) {
        const parsed = positiveInt(value);
        if (parsed) return parsed;
      }
    }
  }
  return undefined;
}

function parseLlamaContext(json: Record<string, unknown> | undefined): number | undefined {
  const settings = json?.default_generation_settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return undefined;
  return positiveInt((settings as Record<string, unknown>).n_ctx);
}

/** Probe native local-backend endpoints and return only safe health metadata. */
export async function probeLlmCapabilities(
  config: LLMProbeConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<LLMCapabilityStatus> {
  const status = baseStatus(config);
  const enabled = config.startupProbe?.enabled ?? status.backend !== "openai-compatible";
  if (!enabled) return status;

  const timeoutMs = positiveInt(config.startupProbe?.timeoutMs) ?? 5_000;
  try {
    let effectiveContextWindow: number | undefined;
    if (status.backend === "ollama") {
      const result = await fetchJson(`${nativeRoot(config.baseUrl)}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.model }),
      }, timeoutMs, fetchImpl);
      if (!result.response.ok) {
        throw new Error(`Ollama /api/show returned HTTP ${result.response.status}`);
      }
      effectiveContextWindow = parseOllamaContext(result.json);
    } else if (status.backend === "llama.cpp") {
      const health = await fetchJson(`${nativeRoot(config.baseUrl)}/health`, {}, timeoutMs, fetchImpl);
      if (!health.response.ok) {
        throw new Error(`llama.cpp /health returned HTTP ${health.response.status}`);
      }
      const props = await fetchJson(`${nativeRoot(config.baseUrl)}/props`, {}, timeoutMs, fetchImpl);
      if (!props.response.ok) {
        throw new Error(`llama.cpp /props returned HTTP ${props.response.status}`);
      }
      effectiveContextWindow = parseLlamaContext(props.json);
      if (!effectiveContextWindow) {
        throw new Error("llama.cpp /props did not report default_generation_settings.n_ctx");
      }
      const caps = props.json?.chat_template_caps;
      if (config.reasoning?.enabled !== undefined
        && (!caps || typeof caps !== "object" || Array.isArray(caps))) {
        throw new Error("llama.cpp /props did not report chat_template_caps required for reasoning control");
      }
    } else {
      const models = await fetchJson(`${config.baseUrl.replace(/\/+$/, "")}/models`, {
        headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
      }, timeoutMs, fetchImpl);
      if (!models.response.ok) {
        throw new Error(`OpenAI-compatible /models returned HTTP ${models.response.status}`);
      }
    }

    status.state = "ready";
    status.effectiveContextWindow = effectiveContextWindow ?? status.configuredContextWindow;
    status.effectiveInputBudgetTokens = effectiveBudget(config, status.effectiveContextWindow);
    const contextError = contextConfigurationError(config, status.effectiveContextWindow);
    if (contextError) {
      status.state = "degraded";
      status.detail = `model ready but context configuration is incompatible: ${contextError}`;
      return status;
    }
    status.detail = status.effectiveContextWindow
      ? `model ready; effective context window ${status.effectiveContextWindow} tokens`
      : "model endpoint ready; backend did not report a context window";
    return status;
  } catch (error) {
    status.state = "degraded";
    const message = error instanceof Error ? error.message : String(error);
    const contextError = contextConfigurationError(config);
    status.detail = `model/backend compatibility probe failed: ${boundedDiagnostic(message)}`
      + (contextError ? `; context configuration is incompatible: ${contextError}` : "");
    return status;
  }
}

export class PromptContextLimitError extends Error {
  readonly inputTokens: number;
  readonly inputBudgetTokens: number;
  readonly configuredContextWindow?: number;
  readonly effectiveContextWindow?: number;

  constructor(args: {
    inputTokens: number;
    inputBudgetTokens: number;
    configuredContextWindow?: number;
    effectiveContextWindow?: number;
  }) {
    super(
      `LLM prompt requires ${args.inputTokens} tokens but effective input budget is `
      + `${args.inputBudgetTokens} (configured context=${args.configuredContextWindow ?? "unknown"}, `
      + `effective context=${args.effectiveContextWindow ?? "unknown"}); refusing silent truncation`,
    );
    this.name = "PromptContextLimitError";
    this.inputTokens = args.inputTokens;
    this.inputBudgetTokens = args.inputBudgetTokens;
    this.configuredContextWindow = args.configuredContextWindow;
    this.effectiveContextWindow = args.effectiveContextWindow;
  }
}

/** Refuse requests which a configured/probed backend would silently truncate. */
export function assertPromptWithinContext(
  systemPrompt: string | undefined,
  prompt: string,
  config: StandaloneLLMCapabilityConfig,
  maxOutputTokens: number,
): number {
  const context = positiveInt(config.effectiveContextWindow) ?? positiveInt(config.contextWindow);
  const budget = positiveInt(config.inputBudgetTokens)
    ?? (context ? Math.max(1, context - maxOutputTokens) : undefined);
  const inputTokens = tiktokenCount(`${systemPrompt ?? ""}\n${prompt}`) + 8;
  if (budget && inputTokens > budget) {
    throw new PromptContextLimitError({
      inputTokens,
      inputBudgetTokens: budget,
      configuredContextWindow: positiveInt(config.contextWindow),
      effectiveContextWindow: context,
    });
  }
  return inputTokens;
}
