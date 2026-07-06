import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("cache-aware context defaults", () => {
  it("defaults recall to tool-only with injected dynamic memories hidden and unpersisted", () => {
    const cfg = parseConfig({});

    expect(cfg.recall.mode).toBe("tool-only");
    expect(cfg.recall.showInjected).toBe(false);
    expect(cfg.recall.persistInjected).toBe(false);
    expect(cfg.recall.maxSearchCallsPerTurn).toBe(3);
  });

  it("parses front-offload and cache-epoch controls", () => {
    const cfg = parseConfig({
      recall: { mode: "auto", showInjected: true, persistInjected: false },
      offload: {
        inlineToolResultMaxTokens: 32,
        summaryMaxTokens: 12,
        previewMaxChars: 80,
        epochTriggerRatio: 0.7,
      },
    });

    expect(cfg.recall.mode).toBe("auto");
    expect(cfg.recall.showInjected).toBe(true);
    expect(cfg.recall.persistInjected).toBe(false);
    expect(cfg.offload.inlineToolResultMaxTokens).toBe(32);
    expect(cfg.offload.summaryMaxTokens).toBe(12);
    expect(cfg.offload.previewMaxChars).toBe(80);
    expect(cfg.offload.epochTriggerRatio).toBe(0.7);
  });
});
