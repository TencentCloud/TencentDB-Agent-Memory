import { describe, expect, it } from "vitest";

interface BenchmarkModule {
  normalizeUsage: (usage: unknown) => Record<string, unknown>;
  buildRequest: (
    variant: "legacy" | "optimized",
    turn: number,
    experimentId: string,
    model: string,
  ) => {
    model: string;
    messages: Array<{ role: string; content: string }>;
  };
  aggregate: (samples: Array<Record<string, unknown>>) => Record<string, unknown>;
}

const benchmark = await import("../../../scripts/benchmark-prompt-cache.mjs") as BenchmarkModule;

describe("prompt-cache provider benchmark", () => {
  it("isolates stable and volatile sections in the two prompt variants", () => {
    const legacy = benchmark.buildRequest("legacy", 1, "legacy-run", "deepseek-chat");
    const optimized = benchmark.buildRequest("optimized", 1, "optimized-run", "deepseek-chat");
    const legacySystem = legacy.messages[0].content;
    const optimizedSystem = optimized.messages[0].content;
    const legacyUser = legacy.messages[1].content;
    const optimizedUser = optimized.messages[1].content;

    expect(legacy.model).toBe("deepseek-chat");
    expect(legacySystem.indexOf("# Runtime")).toBeLessThan(legacySystem.indexOf("<user-persona>"));
    expect(optimizedSystem.indexOf("<user-persona>"))
      .toBeLessThan(optimizedSystem.indexOf("# Runtime"));
    expect(legacyUser.indexOf("<relevant-memories>"))
      .toBeLessThan(legacyUser.indexOf("Confirm the benchmark"));
    expect(optimizedUser.indexOf("Confirm the benchmark"))
      .toBeLessThan(optimizedUser.indexOf("<relevant-memories>"));
  });

  it("parses both DeepSeek and OpenAI-compatible cache detail shapes", () => {
    expect(benchmark.normalizeUsage({
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 800,
      prompt_cache_miss_tokens: 200,
    })).toMatchObject({ available: true, hitTokens: 800, missTokens: 200, hitRate: 0.8 });

    expect(benchmark.normalizeUsage({
      prompt_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 700 },
    })).toMatchObject({ available: true, hitTokens: 700, missTokens: 300, hitRate: 0.7 });
  });

  it("excludes the cold sample when aggregating provider results", () => {
    expect(benchmark.aggregate([
      { turn: 1, available: true, hitTokens: 0, missTokens: 1000 },
      { turn: 2, available: true, hitTokens: 800, missTokens: 200 },
      { turn: 3, available: true, hitTokens: 900, missTokens: 100 },
    ])).toEqual({
      available: true,
      measuredTurns: 2,
      hitTokens: 1700,
      missTokens: 300,
      hitRate: 0.85,
    });
  });
});
