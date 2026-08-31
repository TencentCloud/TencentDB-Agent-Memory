function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizeProviderUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return { available: false, reason: "missing usage object" };
  }

  const promptTokens = finiteNumber(usage.prompt_tokens);
  const directHit = finiteNumber(usage.prompt_cache_hit_tokens);
  const detailHit = finiteNumber(usage.prompt_tokens_details?.cached_tokens);
  const hitTokens = directHit ?? detailHit;
  const directMiss = finiteNumber(usage.prompt_cache_miss_tokens);
  const missTokens = directMiss ?? (
    promptTokens !== undefined && hitTokens !== undefined
      ? Math.max(0, promptTokens - hitTokens)
      : undefined
  );

  if (hitTokens === undefined || missTokens === undefined) {
    return {
      available: false,
      promptTokens: promptTokens ?? null,
      reason: "provider did not expose cache hit/miss token details",
    };
  }

  const total = hitTokens + missTokens;
  return {
    available: true,
    promptTokens: promptTokens ?? total,
    hitTokens,
    missTokens,
    hitRate: total > 0 ? hitTokens / total : null,
  };
}
export function aggregateWarmSamples(samples) {
  const warm = samples.slice(1);
  const measurable = warm.filter((sample) => sample.available);
  if (measurable.length === 0) {
    return {
      available: false,
      measuredTurns: 0,
      unavailableTurns: warm.length,
      reason: warm.find((sample) => sample.reason)?.reason ?? "no warm samples",
    };
  }

  const hitTokens = measurable.reduce((sum, sample) => sum + sample.hitTokens, 0);
  const missTokens = measurable.reduce((sum, sample) => sum + sample.missTokens, 0);
  const total = hitTokens + missTokens;
  return {
    available: true,
    measuredTurns: measurable.length,
    unavailableTurns: warm.length - measurable.length,
    hitTokens,
    missTokens,
    hitRate: total > 0 ? hitTokens / total : null,
  };
}
