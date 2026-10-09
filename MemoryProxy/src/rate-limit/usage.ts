export type UsageProtocol = "openai" | "anthropic" | "responses";

/**
 * Normalize upstream usage to total model input tokens.
 *
 * This follows the existing ClickHouse/credit conventions:
 * - OpenAI prompt_tokens already includes cached input.
 * - OpenAI Responses input_tokens already includes input_tokens_details.cached_tokens.
 * - Anthropic input_tokens excludes cache reads/creation, so add both back.
 */
export function getActualInputTokens(
  usage: Record<string, unknown> | null | undefined,
  protocol: UsageProtocol,
): number {
  if (!usage) return 0;
  if (protocol === "openai") {
    return numberField(usage.prompt_tokens);
  }
  if (protocol === "responses") {
    return numberField(usage.input_tokens);
  }
  return numberField(usage.input_tokens)
    + numberField(usage.cache_read_input_tokens)
    + numberField(usage.cache_creation_input_tokens);
}

function numberField(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
  }
  return 0;
}
