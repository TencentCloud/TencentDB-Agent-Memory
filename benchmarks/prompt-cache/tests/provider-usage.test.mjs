import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregateWarmSamples,
  normalizeProviderUsage,
} from "../lib/provider-usage.mjs";

test("normalizes DeepSeek cache usage", () => {
  assert.deepEqual(
    normalizeProviderUsage({
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 800,
      prompt_cache_miss_tokens: 200,
    }),
    {
      available: true,
      promptTokens: 1000,
      hitTokens: 800,
      missTokens: 200,
      hitRate: 0.8,
    },
  );
});
test("normalizes cached_tokens usage shape", () => {
  assert.deepEqual(
    normalizeProviderUsage({
      prompt_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 700 },
    }),
    {
      available: true,
      promptTokens: 1000,
      hitTokens: 700,
      missTokens: 300,
      hitRate: 0.7,
    },
  );
});

test("does not turn missing cache details into zero hits", () => {
  const usage = normalizeProviderUsage({ prompt_tokens: 1000 });
  assert.equal(usage.available, false);
});

test("excludes the first cold sample", () => {
  assert.deepEqual(
    aggregateWarmSamples([
      { available: true, hitTokens: 0, missTokens: 1000 },
      { available: true, hitTokens: 800, missTokens: 200 },
      { available: true, hitTokens: 900, missTokens: 100 },
    ]),
    {
      available: true,
      measuredTurns: 2,
      unavailableTurns: 0,
      hitTokens: 1700,
      missTokens: 300,
      hitRate: 0.85,
    },
  );
});
