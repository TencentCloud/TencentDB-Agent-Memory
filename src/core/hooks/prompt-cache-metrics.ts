export interface PromptCacheImpactInput {
  stableContextChars: number;
  dynamicContextChars: number;
  turns: number;
}

export interface PromptCacheImpact {
  turns: number;
  stableContextChars: number;
  dynamicContextChars: number;
  estimatedStableTokens: number;
  estimatedDynamicTokens: number;
  legacyVisibleHistoryChars: number;
  optimizedVisibleHistoryChars: number;
  legacyEstimatedHitRate: number;
  optimizedEstimatedHitRate: number;
  estimatedHitRateDelta: number;
}

const CHARS_PER_TOKEN = 4;

function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

/**
 * Estimate the prompt-cache effect of partitioning stable memory context away
 * from per-turn recalled memories and hiding injected snippets from visible
 * history.
 *
 * This is a deterministic approximation for local validation. Provider-side
 * cache accounting is reported by the provider, but this estimate lets us
 * compare two prompt shapes with the same input sizes:
 *
 * - legacy: showInjected=true, so each previous turn can carry one more copy
 *   of dynamic recalled memories in visible history.
 * - optimized: showInjected=false, so previous injected snippets are not added
 *   to visible history.
 */
export function estimatePromptCacheImpact(input: PromptCacheImpactInput): PromptCacheImpact {
  const turns = Math.max(1, Math.floor(input.turns));
  const stableContextChars = Math.max(0, input.stableContextChars);
  const dynamicContextChars = Math.max(0, input.dynamicContextChars);
  const estimatedStableTokens = estimateTokens(stableContextChars);
  const estimatedDynamicTokens = estimateTokens(dynamicContextChars);

  const legacyVisibleHistoryChars = dynamicContextChars * Math.max(0, turns - 1);
  const optimizedVisibleHistoryChars = 0;

  const legacyDynamicTokens = estimateTokens(dynamicContextChars + legacyVisibleHistoryChars);
  const optimizedDynamicTokens = estimateTokens(dynamicContextChars + optimizedVisibleHistoryChars);

  const legacyEstimatedHitRate = ratio(estimatedStableTokens, estimatedStableTokens + legacyDynamicTokens);
  const optimizedEstimatedHitRate = ratio(estimatedStableTokens, estimatedStableTokens + optimizedDynamicTokens);

  return {
    turns,
    stableContextChars,
    dynamicContextChars,
    estimatedStableTokens,
    estimatedDynamicTokens,
    legacyVisibleHistoryChars,
    optimizedVisibleHistoryChars,
    legacyEstimatedHitRate,
    optimizedEstimatedHitRate,
    estimatedHitRateDelta: optimizedEstimatedHitRate - legacyEstimatedHitRate,
  };
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
