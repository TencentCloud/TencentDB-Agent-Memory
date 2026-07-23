/**
 * Normalize provider-specific prompt-cache usage fields from llm_output events.
 * Observation-only — used when report.enabled=true.
 *
 * Supports common shapes:
 * - DeepSeek: prompt_cache_hit_tokens / prompt_cache_miss_tokens
 * - OpenAI-compatible: usage.prompt_tokens_details.cached_tokens
 * - Anthropic-ish: cache_read_input_tokens / cache_creation_input_tokens
 * - Nested under event.usage / event.response.usage / event.metrics
 */

export interface PromptCacheUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  cacheReadTokens: number | null;
  cacheMissTokens: number | null;
  /** cacheRead / (cacheRead + cacheMiss) when both known; else cacheRead / promptTokens */
  cacheHitRate: number | null;
  providerHint: string | null;
  model: string | null;
  /** Keys observed on the raw usage object (no values — avoids leaking payloads). */
  usageKeys: string[];
}

function pickNum(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
      return Number(v);
    }
  }
  return null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Pull the most likely usage object from a loosely-typed llm_output event. */
export function extractUsageObject(event: unknown): Record<string, unknown> | null {
  const e = asRecord(event);
  if (!e) return null;

  const candidates: unknown[] = [
    e.usage,
    e.tokenUsage,
    e.tokens,
    asRecord(e.response)?.usage,
    asRecord(e.result)?.usage,
    asRecord(e.metrics)?.usage,
    asRecord(e.data)?.usage,
    e,
  ];

  for (const c of candidates) {
    const r = asRecord(c);
    if (!r) continue;
    // Heuristic: look like a usage bag
    if (
      "prompt_tokens" in r ||
      "input_tokens" in r ||
      "prompt_cache_hit_tokens" in r ||
      "cache_read_input_tokens" in r ||
      "cached_tokens" in r ||
      "prompt_tokens_details" in r ||
      "input_tokens_details" in r ||
      "completion_tokens" in r ||
      "output_tokens" in r
    ) {
      return r;
    }
  }
  return null;
}

export function extractModelHint(event: unknown): string | null {
  const e = asRecord(event);
  if (!e) return null;
  const m =
    e.model ??
    asRecord(e.response)?.model ??
    asRecord(e.result)?.model ??
    asRecord(e.provider)?.model;
  return typeof m === "string" && m.length > 0 ? m : null;
}

export function extractProviderHint(event: unknown): string | null {
  const e = asRecord(event);
  if (!e) return null;
  const p =
    e.provider ??
    asRecord(e.providerInfo)?.id ??
    asRecord(e.providerInfo)?.name;
  if (typeof p === "string" && p.length > 0) return p;
  const model = extractModelHint(event);
  if (model && model.includes("/")) return model.split("/", 1)[0] ?? null;
  return null;
}

/**
 * Normalize raw usage into cache read/miss + hit rate.
 * Returns null only when no usage object could be found at all.
 */
export function normalizePromptCacheUsage(event: unknown): PromptCacheUsage | null {
  const usage = extractUsageObject(event);
  if (!usage) return null;

  const details =
    asRecord(usage.prompt_tokens_details) ||
    asRecord(usage.input_tokens_details) ||
    {};

  const promptTokens = pickNum(
    usage.prompt_tokens,
    usage.input_tokens,
    usage.total_tokens,
  );
  const completionTokens = pickNum(
    usage.completion_tokens,
    usage.output_tokens,
  );

  let cacheRead = pickNum(
    usage.prompt_cache_hit_tokens,
    usage.cache_read_input_tokens,
    usage.cached_tokens,
    details.cached_tokens,
    details.cache_read_tokens,
    details.cache_read_input_tokens,
  );

  let cacheMiss = pickNum(
    usage.prompt_cache_miss_tokens,
    usage.cache_creation_input_tokens,
    details.cache_miss_tokens,
    details.cache_creation_input_tokens,
  );

  // If only cached_tokens + prompt_tokens: miss ≈ prompt - cached
  if (cacheRead != null && cacheMiss == null && promptTokens != null) {
    cacheMiss = Math.max(0, promptTokens - cacheRead);
  }

  let cacheHitRate: number | null = null;
  if (cacheRead != null && cacheMiss != null) {
    const denom = cacheRead + cacheMiss;
    if (denom > 0) cacheHitRate = cacheRead / denom;
  } else if (cacheRead != null && promptTokens != null && promptTokens > 0) {
    cacheHitRate = cacheRead / promptTokens;
  }

  return {
    promptTokens,
    completionTokens,
    cacheReadTokens: cacheRead,
    cacheMissTokens: cacheMiss,
    cacheHitRate,
    providerHint: extractProviderHint(event),
    model: extractModelHint(event),
    usageKeys: Object.keys(usage).slice(0, 32),
  };
}

/** Compact payload for report("prompt_cache_usage", ...). */
export function toPromptCacheReportPayload(
  usage: PromptCacheUsage,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheMissTokens: usage.cacheMissTokens,
    cacheHitRate:
      usage.cacheHitRate != null ? +usage.cacheHitRate.toFixed(6) : null,
    cacheHitRatePct:
      usage.cacheHitRate != null
        ? +((usage.cacheHitRate * 100).toFixed(2))
        : null,
    provider: usage.providerHint,
    model: usage.model,
    usageKeys: usage.usageKeys,
    ...extra,
  };
}
