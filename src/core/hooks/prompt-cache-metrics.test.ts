import { describe, expect, it } from "vitest";
import { estimatePromptCacheImpact, formatPercent } from "./prompt-cache-metrics.js";

describe("estimatePromptCacheImpact", () => {
  it("reduces visible history growth when showInjected is treated as false", () => {
    const impact = estimatePromptCacheImpact({
      stableContextChars: 2400,
      dynamicContextChars: 900,
      turns: 8,
    });

    expect(impact.legacyVisibleHistoryChars).toBe(6300);
    expect(impact.optimizedVisibleHistoryChars).toBe(0);
    expect(impact.optimizedEstimatedHitRate).toBeGreaterThan(impact.legacyEstimatedHitRate);
    expect(formatPercent(impact.optimizedEstimatedHitRate)).toMatch(/%$/);
  });

  it("degrades the legacy hit rate faster as turns grow", () => {
    const turn3 = estimatePromptCacheImpact({
      stableContextChars: 2400,
      dynamicContextChars: 900,
      turns: 3,
    });
    const turn8 = estimatePromptCacheImpact({
      stableContextChars: 2400,
      dynamicContextChars: 900,
      turns: 8,
    });

    expect(turn8.legacyEstimatedHitRate).toBeLessThan(turn3.legacyEstimatedHitRate);
    expect(turn8.estimatedHitRateDelta).toBeGreaterThan(0);
  });
});
