import { describe, expect, it } from "vitest";
import { parseConfig } from "../../config.js";
import { applyRecallBudget } from "./auto-recall.js";

describe("applyRecallBudget", () => {
  it("accounts for separators across multiple recalled memories", () => {
    const recall = parseConfig({
      recall: {
        maxTotalRecallChars: 90,
      },
    }).recall;
    const lines = [
      `- [fact] ${"a".repeat(35)}`,
      `- [fact] ${"b".repeat(35)}`,
      `- [fact] ${"c".repeat(35)}`,
    ];

    const result = applyRecallBudget(lines, recall);

    expect(result.length).toBeGreaterThan(1);
    expect(result.join("\n").length).toBeLessThanOrEqual(90);
  });
});

