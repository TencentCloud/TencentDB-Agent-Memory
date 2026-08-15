import { compareVersionXYZ, parseVersionXYZ } from "../../utils/ensure-hook-policy.js";

/** First release in the supported line exposing llm_output cache usage. */
export const PROMPT_CACHE_USAGE_HOOK_MIN_VERSION = [2026, 4, 24] as const;

export interface NormalizedPromptCacheUsage {
  provider: string;
  model: string;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheMissTokens: number;
  promptTokens: number;
  cacheHitRate: number | null;
}

export interface PromptCacheUsageEvent {
  provider?: unknown;
  model?: unknown;
  usage?: unknown;
}

export function supportsPromptCacheUsageHook(rawHostVersion: unknown): boolean {
  const parsed = parseVersionXYZ(rawHostVersion);
  return parsed !== null && compareVersionXYZ(parsed, PROMPT_CACHE_USAGE_HOOK_MIN_VERSION) >= 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : undefined;
}

function label(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "unknown";
}

/**
 * Normalize OpenClaw's provider-independent LLM usage fields.
 *
 * OpenClaw exposes uncached input, cache reads, and cache writes separately.
 * Cache writes are misses for hit-rate accounting even when a provider bills
 * them differently.
 */
export function normalizePromptCacheUsage(
  event: PromptCacheUsageEvent,
): NormalizedPromptCacheUsage | undefined {
  const usage = asRecord(event.usage);
  if (!usage) return undefined;

  const input = tokenCount(usage.input);
  const cacheRead = tokenCount(usage.cacheRead);
  const cacheWrite = tokenCount(usage.cacheWrite);
  if (input === undefined && cacheRead === undefined && cacheWrite === undefined) {
    return undefined;
  }

  const uncachedInputTokens = input ?? 0;
  const cacheReadTokens = cacheRead ?? 0;
  const cacheWriteTokens = cacheWrite ?? 0;
  const cacheMissTokens = uncachedInputTokens + cacheWriteTokens;
  const promptTokens = cacheMissTokens + cacheReadTokens;

  return {
    provider: label(event.provider),
    model: label(event.model),
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheMissTokens,
    promptTokens,
    cacheHitRate: promptTokens > 0 ? cacheReadTokens / promptTokens : null,
  };
}
