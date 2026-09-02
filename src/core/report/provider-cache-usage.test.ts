import { describe, expect, it } from "vitest";
import { summarizeTurnProviderCacheUsage } from "./provider-cache-usage.js";

function assistant(params: {
  provider?: string;
  model?: string;
  responseModel?: string;
  api?: string;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): Record<string, unknown> {
  const {
    provider = "deepseek",
    model = "deepseek-chat",
    responseModel,
    api = "openai-completions",
    input = 0,
    cacheRead = 0,
    cacheWrite = 0,
  } = params;

  return {
    role: "assistant",
    provider,
    model,
    ...(responseModel ? { responseModel } : {}),
    api,
    usage: { input, cacheRead, cacheWrite },
  };
}

describe("summarizeTurnProviderCacheUsage", () => {
  it("excludes usage before the current-turn message boundary", () => {
    const result = summarizeTurnProviderCacheUsage([
      assistant({ input: 900, cacheRead: 100 }),
      { role: "user", content: "current turn" },
      assistant({ input: 100, cacheRead: 900 }),
    ], 1);

    expect(result).toEqual({
      callCount: 1,
      uncachedInputTokens: 100,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
      cacheMissTokens: 100,
      promptTokens: 1000,
      cacheHitRate: 0.9,
      providers: [{
        provider: "deepseek",
        model: "deepseek-chat",
        api: "openai-completions",
        callCount: 1,
        uncachedInputTokens: 100,
        cacheReadTokens: 900,
        cacheWriteTokens: 0,
        cacheMissTokens: 100,
        promptTokens: 1000,
        cacheHitRate: 0.9,
      }],
    });
  });

  it("aggregates multiple model calls from one tool-using turn", () => {
    const result = summarizeTurnProviderCacheUsage([
      { role: "user", content: "use a tool" },
      assistant({ input: 100, cacheRead: 900 }),
      { role: "toolResult", content: "result" },
      assistant({ input: 200, cacheRead: 1000, cacheWrite: 50 }),
    ], 0);

    expect(result?.callCount).toBe(2);
    expect(result?.promptTokens).toBe(2250);
    expect(result?.cacheReadTokens).toBe(1900);
    expect(result?.cacheWriteTokens).toBe(50);
    expect(result?.cacheMissTokens).toBe(350);
    expect(result?.cacheHitRate).toBeCloseTo(1900 / 2250);
    expect(result?.providers[0].callCount).toBe(2);
  });

  it("groups providers separately for DeepSeek and MiMo comparisons", () => {
    const result = summarizeTurnProviderCacheUsage([
      assistant({
        provider: "xiaomi",
        model: "mimo-auto",
        responseModel: "mimo-v2.5",
        input: 400,
        cacheRead: 600,
      }),
      assistant({ provider: "deepseek", input: 200, cacheRead: 800 }),
    ], 0);

    expect(result?.providers.map(({ provider, model }) => ({ provider, model }))).toEqual([
      { provider: "deepseek", model: "deepseek-chat" },
      { provider: "xiaomi", model: "mimo-v2.5" },
    ]);
    expect(result?.providers[0].cacheHitRate).toBe(0.8);
    expect(result?.providers[1].cacheHitRate).toBe(0.6);
    expect(result?.cacheHitRate).toBe(0.7);
  });

  it("includes cache writes in the prompt-token denominator", () => {
    const result = summarizeTurnProviderCacheUsage([
      assistant({ input: 100, cacheRead: 300, cacheWrite: 100 }),
    ], 0);

    expect(result?.promptTokens).toBe(500);
    expect(result?.cacheMissTokens).toBe(200);
    expect(result?.cacheHitRate).toBe(0.6);
  });

  it("ignores malformed usage and rejects an unavailable turn boundary", () => {
    expect(summarizeTurnProviderCacheUsage([
      { role: "assistant", usage: { input: "100", cacheRead: Number.NaN } },
      { role: "user", usage: { input: 100 } },
    ], 0)).toBeUndefined();
    expect(summarizeTurnProviderCacheUsage([assistant({ input: 100 })], undefined))
      .toBeUndefined();
    expect(summarizeTurnProviderCacheUsage([assistant({ input: 100 })], 2))
      .toBeUndefined();
  });
});
