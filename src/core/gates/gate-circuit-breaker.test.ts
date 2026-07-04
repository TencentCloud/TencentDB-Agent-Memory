import { describe, it, expect, beforeEach, vi } from "vitest";
import { CircuitBreakerGate } from "./gate-circuit-breaker.js";
import { CircuitOpenError } from "./types.js";

describe("CircuitBreakerGate", () => {
  let gate: CircuitBreakerGate;
  beforeEach(() => {
    gate = new CircuitBreakerGate({ threshold: 3, cooldownMs: 60_000, maxCooldownMs: 300_000 });
    vi.useFakeTimers();
  });

  it("trips open after threshold consecutive failures", () => {
    vi.setSystemTime(0);
    gate.onError("test", new Error("e1")); gate.onError("test", new Error("e2")); gate.onError("test", new Error("e3"));
    expect(gate._isOpen()).toBe(true);
    expect(() => gate.beforeCall("test")).toThrow(CircuitOpenError);
  });

  it("blocks calls while open", () => {
    vi.setSystemTime(0);
    gate.onError("test", new Error("e1")); gate.onError("test", new Error("e2")); gate.onError("test", new Error("e3"));
    vi.advanceTimersByTime(30_000);
    expect(gate._isOpen()).toBe(true);
    expect(() => gate.beforeCall("test")).toThrow(CircuitOpenError);
  });

  it("resets to closed after timer expires", () => {
    vi.setSystemTime(0);
    gate.onError("test", new Error("e1")); gate.onError("test", new Error("e2")); gate.onError("test", new Error("e3"));
    vi.advanceTimersByTime(61_000);
    expect(gate._isOpen()).toBe(false);
    expect(() => gate.beforeCall("test")).not.toThrow();
  });

  it("escalates cooldown on rapid reset→open cycles", () => {
    vi.setSystemTime(0);
    gate.onError("test", new Error("e1")); gate.onError("test", new Error("e2")); gate.onError("test", new Error("e3"));
    vi.advanceTimersByTime(61_000);
    gate.beforeCall("test"); // reset
    gate.onError("test", new Error("e1")); gate.onError("test", new Error("e2")); gate.onError("test", new Error("e3"));
    vi.advanceTimersByTime(30_000);
    expect(gate._isOpen()).toBe(true); // still in escalated cooldown
    vi.advanceTimersByTime(91_000);
    expect(gate._isOpen()).toBe(false);
  });
});
