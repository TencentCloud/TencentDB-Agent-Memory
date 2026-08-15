import { describe, expect, it } from "vitest";

import {
  normalizePromptCacheUsage,
  supportsPromptCacheUsageHook,
} from "./prompt-cache-usage.js";

describe("supportsPromptCacheUsageHook", () => {
  it("gates llm_output usage telemetry by host version", () => {
    expect(supportsPromptCacheUsageHook("2026.4.24")).toBe(true);
    expect(supportsPromptCacheUsageHook("2026.5.28-1")).toBe(true);
    expect(supportsPromptCacheUsageHook("2026.4.23")).toBe(false);
    expect(supportsPromptCacheUsageHook(undefined)).toBe(false);
  });
});

describe("normalizePromptCacheUsage", () => {
  it("normalizes DeepSeek cache reads and misses", () => {
    expect(normalizePromptCacheUsage({
      provider: "deepseek",
      model: "deepseek-chat",
      usage: { input: 100, cacheRead: 900, cacheWrite: 0 },
    })).toEqual({
      provider: "deepseek",
      model: "deepseek-chat",
      uncachedInputTokens: 100,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
      cacheMissTokens: 100,
      promptTokens: 1000,
      cacheHitRate: 0.9,
    });
  });

  it("accounts for MiMo cache writes as misses", () => {
    const result = normalizePromptCacheUsage({
      provider: "xiaomi",
      model: "mimo-v2.5-pro",
      usage: { input: 200, cacheRead: 700, cacheWrite: 100 },
    });

    expect(result?.cacheMissTokens).toBe(300);
    expect(result?.promptTokens).toBe(1000);
    expect(result?.cacheHitRate).toBe(0.7);
  });

  it("rejects usage without numeric cache accounting", () => {
    expect(normalizePromptCacheUsage({ usage: { input: "100" } })).toBeUndefined();
    expect(normalizePromptCacheUsage({ usage: undefined })).toBeUndefined();
  });

  it("clamps invalid negative counts and preserves a zero-token sample", () => {
    expect(normalizePromptCacheUsage({
      provider: " ",
      usage: { input: -1, cacheRead: 0, cacheWrite: 0 },
    })).toEqual({
      provider: "unknown",
      model: "unknown",
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheMissTokens: 0,
      promptTokens: 0,
      cacheHitRate: null,
    });
  });
});
