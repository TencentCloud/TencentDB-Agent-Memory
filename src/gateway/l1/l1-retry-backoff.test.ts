import { describe, expect, it } from "vitest";
import { l1RetryAt } from "./l1-retry-backoff.js";

describe("L1 assignment retry backoff", () => {
  it("grows exponentially and stays bounded", () => {
    expect(l1RetryAt(1_000, 0)).toBe(6_000);
    expect(l1RetryAt(1_000, 2)).toBe(21_000);
    expect(l1RetryAt(1_000, 99)).toBe(301_000);
  });
});
