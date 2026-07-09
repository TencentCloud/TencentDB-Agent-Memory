import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("cache-aware context defaults", () => {
  it("keeps automatic recall as the backward-compatible default", () => {
    const cfg = parseConfig({});

    expect(cfg.recall.mode).toBe("auto");
    expect(cfg.recall.maxSearchCallsPerTurn).toBe(3);
  });

  it("parses opt-in tool-only mode and bounded recall controls", () => {
    const cfg = parseConfig({
      recall: {
        mode: "tool-only",
        sessionSnapshotMaxTokens: 800,
        sceneSummaryMaxItems: 4,
        dynamicRecallMaxTokens: 500,
        maxSearchCallsPerTurn: 2,
      },
    });

    expect(cfg.recall.mode).toBe("tool-only");
    expect(cfg.recall.sessionSnapshotMaxTokens).toBe(800);
    expect(cfg.recall.sceneSummaryMaxItems).toBe(4);
    expect(cfg.recall.dynamicRecallMaxTokens).toBe(500);
    expect(cfg.recall.maxSearchCallsPerTurn).toBe(2);
  });
});
