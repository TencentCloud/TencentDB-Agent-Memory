import { describe, it, expect, beforeEach, vi } from "vitest";
import { RateLimitGate } from "./gate-rate-limit.js";

describe("RateLimitGate", () => {
  let gate: RateLimitGate;
  beforeEach(() => {
    gate = new RateLimitGate({ windowMs: 1000, maxCalls: 3, selfFallbackThreshold: 3 });
    vi.useFakeTimers();
  });

  it("allows calls under the limit", () => {
    expect(() => gate.beforeCall("test")).not.toThrow();
    expect(() => gate.beforeCall("test")).not.toThrow();
    expect(() => gate.beforeCall("test")).not.toThrow();
  });

  it("blocks calls over the limit", () => {
    gate.beforeCall("test"); gate.beforeCall("test"); gate.beforeCall("test");
    expect(() => gate.beforeCall("test")).toThrow("Rate limit exceeded");
  });

  it("self-fallback after N consecutive failures", () => {
    gate.onError("test", new Error("e"));
    gate.onError("test", new Error("e"));
    gate.onError("test", new Error("e"));
    gate.beforeCall("test"); gate.beforeCall("test");
    expect(() => gate.beforeCall("test")).not.toThrow();
  });

  it("recovers from self-fallback after duration expires", () => {
    vi.setSystemTime(0);
    gate.onError("test", new Error("e")); gate.onError("test", new Error("e")); gate.onError("test", new Error("e"));
    gate.beforeCall("test"); // allowed in fail-open
    vi.advanceTimersByTime(31_000);
    gate._reset();
    gate.beforeCall("test"); gate.beforeCall("test"); gate.beforeCall("test");
    expect(() => gate.beforeCall("test")).toThrow("Rate limit exceeded");
  });
});
