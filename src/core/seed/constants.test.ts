import { describe, expect, it } from "vitest";
import { MAX_L1_CONCURRENCY, normalizeL1Concurrency } from "./constants.js";

describe("seed constants", () => {
  it("caps L1 concurrency at the shared maximum", () => {
    expect(MAX_L1_CONCURRENCY).toBe(32);
    expect(normalizeL1Concurrency(999, 1)).toBe(MAX_L1_CONCURRENCY);
  });

  it("normalizes invalid L1 concurrency values to the caller fallback", () => {
    expect(normalizeL1Concurrency(0, 7)).toBe(7);
    expect(normalizeL1Concurrency("not-a-number", 7)).toBe(7);
  });
});
