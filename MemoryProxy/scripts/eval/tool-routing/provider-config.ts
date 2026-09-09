import type { EvalMessage, RunRecord } from "./types.js";

type Configuration = RunRecord["request_config"];

/** Metadata and wire parameters must describe the same experiment. */
export function providerConfiguration(maxResponses = 12, maxCompletionTokens = 8192, requestTimeoutMs = 60_000): Configuration {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 300_000) {
    throw new Error("Provider timeout must be 1000..300000 milliseconds");
  }
  const extra = JSON.parse(process.env.TOOL_ROUTING_EXTRA_BODY_JSON ?? "{}") as Record<string, unknown>;
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) throw new Error("Extra body must be an object");
  for (const reserved of ["model", "messages", "tools", "temperature", "top_p", "max_tokens", "stream", "tool_choice"]) {
    if (Object.hasOwn(extra, reserved)) throw new Error(`Extra body may not override ${reserved}`);
  }
  const wireThinking = extra.thinking as { type?: unknown } | undefined;
  if (wireThinking !== undefined && (!wireThinking || typeof wireThinking !== "object"
    || !["enabled", "disabled"].includes(String(wireThinking.type)))) throw new Error("Invalid thinking request field");
  const mode = process.env.TOOL_ROUTING_THINKING_MODE || String(wireThinking?.type ?? "provider-default");
  if (!["enabled", "disabled", "provider-default"].includes(mode)) throw new Error("Invalid thinking mode");
  if (wireThinking && wireThinking.type !== mode) throw new Error("Thinking metadata conflicts with request body");
  if (mode !== "provider-default") extra.thinking = { type: mode };
  if (mode === "enabled") extra.reasoning_effort ??= "high";
  return {
    ...(mode === "enabled" ? {} : { temperature: 0, top_p: 1 }),
    thinking_mode: mode, host: "workspace-cli-v1",
    max_responses: maxResponses, max_completion_tokens: maxCompletionTokens, request_timeout_ms: requestTimeoutMs,
    ...(mode === "enabled" ? { initial_history_reasoning: "preserve-or-empty-synthetic-history" as const } : {}),
    ...(Object.keys(extra).length ? { extra_body: extra } : {}),
  };
}

export function providerRequestParams(model: string, config: Configuration): Record<string, unknown> {
  return { model, ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(config.top_p !== undefined ? { top_p: config.top_p } : {}),
    max_tokens: config.max_completion_tokens, ...config.extra_body };
}

/** Initial fixtures are authored state, not a recorded chain of model reasoning. */
export function providerHistory(messages: readonly EvalMessage[], config: Configuration): EvalMessage[] {
  return messages.map((message) => config.thinking_mode === "enabled" && message.role === "assistant"
    ? { ...structuredClone(message), reasoning_content: message.reasoning_content ?? "" }
    : structuredClone(message));
}
