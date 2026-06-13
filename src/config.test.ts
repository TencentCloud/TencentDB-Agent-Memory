import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig recall budget", () => {
  it("defaults recall character budgets to disabled", () => {
    const cfg = parseConfig({});

    expect(cfg.recall.maxCharsPerMemory).toBe(0);
    expect(cfg.recall.maxTotalRecallChars).toBe(0);
  });

  it("reads recall character budget options", () => {
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
