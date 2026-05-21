import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig", () => {
  it("defaults recall injection budgets to bounded values", () => {
    const cfg = parseConfig({});

    expect(cfg.recall.maxCharsPerMemory).toBe(800);
    expect(cfg.recall.maxTotalRecallChars).toBe(3000);
  });

  it("parses recall injection character budgets", () => {
    const cfg = parseConfig({
      recall: {
        maxCharsPerMemory: 800,
        maxTotalRecallChars: 3000,
      },
    });

    expect(cfg.recall.maxCharsPerMemory).toBe(800);
    expect(cfg.recall.maxTotalRecallChars).toBe(3000);
  });
});
