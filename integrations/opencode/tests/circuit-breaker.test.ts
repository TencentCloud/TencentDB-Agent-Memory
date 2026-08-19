import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../src/circuit-breaker.js";

describe("CircuitBreaker", () => {
  it("opens at the threshold and resets after cooldown", () => {
    let now = 100;
    const breaker = new CircuitBreaker(2, 50, () => now);
    breaker.failure();
    expect(breaker.isOpen()).toBe(false);
    breaker.failure();
    expect(breaker.isOpen()).toBe(true);
    now = 151;
    expect(breaker.isOpen()).toBe(false);
  });

  it("resets on success", () => {
    const breaker = new CircuitBreaker(1, 100);
    breaker.failure();
    breaker.success();
    expect(breaker.isOpen()).toBe(false);
  });
});
