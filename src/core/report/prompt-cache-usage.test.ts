import { describe, expect, it } from "vitest";
import {
  extractUsageObject,
  normalizePromptCacheUsage,
  toPromptCacheReportPayload,
} from "./prompt-cache-usage.js";

describe("normalizePromptCacheUsage", () => {
  it("parses DeepSeek-style hit/miss tokens", () => {
    const u = normalizePromptCacheUsage({
      model: "deepseek-chat",
      provider: "deepseek",
      usage: {
        prompt_tokens: 3260,
        completion_tokens: 20,
        prompt_cache_hit_tokens: 1408,
        prompt_cache_miss_tokens: 1852,
      },
    });
    expect(u).not.toBeNull();
    expect(u!.cacheReadTokens).toBe(1408);
    expect(u!.cacheMissTokens).toBe(1852);
    expect(u!.cacheHitRate).toBeCloseTo(1408 / (1408 + 1852), 5);
    expect(u!.model).toBe("deepseek-chat");
    expect(u!.providerHint).toBe("deepseek");
  });

  it("parses OpenAI-compatible cached_tokens details", () => {
    const u = normalizePromptCacheUsage({
      usage: {
        prompt_tokens: 1000,
        prompt_tokens_details: { cached_tokens: 600 },
        completion_tokens: 10,
      },
    });
    expect(u!.cacheReadTokens).toBe(600);
    expect(u!.cacheMissTokens).toBe(400);
    expect(u!.cacheHitRate).toBeCloseTo(0.6, 5);
  });

  it("parses Anthropic-ish cache_read / cache_creation", () => {
    const u = normalizePromptCacheUsage({
      usage: {
        input_tokens: 500,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 200,
        output_tokens: 5,
      },
    });
    expect(u!.cacheReadTokens).toBe(300);
    expect(u!.cacheMissTokens).toBe(200);
  });

  it("finds nested response.usage", () => {
    const raw = extractUsageObject({
      response: { usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6 } },
    });
    expect(raw?.prompt_tokens).toBe(10);
    const u = normalizePromptCacheUsage({
      response: { usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6 } },
    });
    expect(u!.cacheReadTokens).toBe(4);
  });

  it("returns null when no usage-like object", () => {
    expect(normalizePromptCacheUsage({ foo: 1 })).toBeNull();
    expect(normalizePromptCacheUsage(null)).toBeNull();
  });

  it("does not invent hit rate without cache fields", () => {
    const u = normalizePromptCacheUsage({
      usage: { prompt_tokens: 100, completion_tokens: 5 },
    });
    expect(u).not.toBeNull();
    expect(u!.cacheReadTokens).toBeNull();
    expect(u!.cacheHitRate).toBeNull();
  });

  it("toPromptCacheReportPayload is compact and numeric-safe", () => {
    const u = normalizePromptCacheUsage({
      usage: {
        prompt_tokens: 100,
        prompt_cache_hit_tokens: 25,
        prompt_cache_miss_tokens: 75,
      },
    })!;
    const p = toPromptCacheReportPayload(u, { sessionKey: "s1" });
    expect(p.cacheHitRatePct).toBe(25);
    expect(p.sessionKey).toBe("s1");
    expect(p.cacheReadTokens).toBe(25);
  });
});
