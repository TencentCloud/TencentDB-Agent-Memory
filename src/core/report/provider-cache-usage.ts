interface CacheTokenCounts {
  callCount: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface DerivedCacheUsage {
  cacheMissTokens: number;
  promptTokens: number;
  cacheHitRate: number | null;
}

export type ProviderCacheUsage = CacheTokenCounts & DerivedCacheUsage & {
  provider: string;
  model: string;
  api: string | null;
};

export type TurnProviderCacheUsage = CacheTokenCounts & DerivedCacheUsage & {
  providers: ProviderCacheUsage[];
};

type UsageAccumulator = CacheTokenCounts & {
  provider: string;
  model: string;
  api: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function withDerivedUsage<T extends CacheTokenCounts>(counts: T): T & DerivedCacheUsage {
  // OpenClaw reports uncached input, cache reads, and cache writes separately.
  const cacheMissTokens = counts.uncachedInputTokens + counts.cacheWriteTokens;
  const promptTokens = cacheMissTokens + counts.cacheReadTokens;
  return {
    ...counts,
    cacheMissTokens,
    promptTokens,
    cacheHitRate: promptTokens > 0 ? counts.cacheReadTokens / promptTokens : null,
  };
}

/**
 * Summarize OpenClaw-normalized assistant usage for one agent turn.
 *
 * `startIndex` is the message count captured by `before_prompt_build`. Using
 * that boundary avoids counting usage from earlier turns in the session-wide
 * `agent_end.messages` snapshot.
 */
export function summarizeTurnProviderCacheUsage(
  messages: unknown[],
  startIndex: number | undefined,
): TurnProviderCacheUsage | undefined {
  if (
    startIndex === undefined ||
    !Number.isInteger(startIndex) ||
    startIndex < 0 ||
    startIndex > messages.length
  ) {
    return undefined;
  }

  const grouped = new Map<string, UsageAccumulator>();

  for (const rawMessage of messages.slice(startIndex)) {
    const message = asRecord(rawMessage);
    const usage = message?.role === "assistant" ? asRecord(message.usage) : undefined;
    if (!usage) continue;

    const input = asTokenCount(usage.input);
    const cacheRead = asTokenCount(usage.cacheRead);
    const cacheWrite = asTokenCount(usage.cacheWrite);
    if (input === undefined && cacheRead === undefined && cacheWrite === undefined) continue;

    const provider = asNonEmptyString(message.provider) ?? "unknown";
    const model =
      asNonEmptyString(message.responseModel) ??
      asNonEmptyString(message.model) ??
      "unknown";
    const api = asNonEmptyString(message.api) ?? null;
    const key = JSON.stringify([provider, model, api]);
    const current = grouped.get(key) ?? {
      provider,
      model,
      api,
      callCount: 0,
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };

    current.callCount += 1;
    current.uncachedInputTokens += input ?? 0;
    current.cacheReadTokens += cacheRead ?? 0;
    current.cacheWriteTokens += cacheWrite ?? 0;
    grouped.set(key, current);
  }

  if (grouped.size === 0) return undefined;

  const providers = [...grouped.values()]
    .map((usage) => withDerivedUsage(usage))
    .sort((left, right) =>
      compareText(left.provider, right.provider) ||
      compareText(left.model, right.model) ||
      compareText(left.api ?? "", right.api ?? ""),
    );
  const total = providers.reduce<CacheTokenCounts>(
    (acc, usage) => ({
      callCount: acc.callCount + usage.callCount,
      uncachedInputTokens: acc.uncachedInputTokens + usage.uncachedInputTokens,
      cacheReadTokens: acc.cacheReadTokens + usage.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + usage.cacheWriteTokens,
    }),
    { callCount: 0, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  );

  return { ...withDerivedUsage(total), providers };
}
