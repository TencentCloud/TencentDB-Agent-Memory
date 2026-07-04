/**
 * R2 red-team tests for gate middleware.
 *
 * Attack-surface tests: rate-limit recovery, circuit-breaker escalation,
 * concurrency stress, and boundary values.
 */

import { describe, it, expect, vi } from "vitest";
import { RateLimitGate } from "./gate-rate-limit.js";
import { CircuitBreakerGate } from "./gate-circuit-breaker.js";
import { AuditGate } from "./gate-audit.js";
import { CircuitOpenError } from "./types.js";

// ---------------------------------------------------------------------------
// Rate-limit gate
// ---------------------------------------------------------------------------

describe("RateLimitGate — red-team", () => {
  it("recovers after rate-limit window expires", () => {
    vi.useFakeTimers();
    const gate = new RateLimitGate({ windowMs: 1000, maxCalls: 2, selfFallbackThreshold: 0 });

    // Fill the bucket
    gate.beforeCall("test");
    gate.beforeCall("test");
    expect(() => gate.beforeCall("test")).toThrow("Rate limit exceeded");

    // Advance past the window
    vi.advanceTimersByTime(1001);

    // Should be able to call again
    expect(() => gate.beforeCall("test")).not.toThrow();
    gate.beforeCall("test");
    expect(() => gate.beforeCall("test")).toThrow("Rate limit exceeded");

    vi.useRealTimers();
  });

  it("self-fallback allows calls then recovers after reset", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const gate = new RateLimitGate({
      windowMs: 60_000, maxCalls: 3, selfFallbackThreshold: 2, selfFallbackDurationMs: 30_000,
    });

    // N consecutive onError calls → self-fallback triggered
    gate.onError("test", new Error("e1"));
    gate.onError("test", new Error("e2"));
    // Now in fail-open mode: beforeCall bypasses rate-limit check
    gate.beforeCall("test");
    gate.beforeCall("test");
    gate.beforeCall("test"); // would normally throw but fail-open allows it

    // Even with a full bucket, calls pass because self-fallback is active
    // (selfOpenUntil = 30000, Date.now() = 0 < 30000, so beforeCall returns early)
    expect(() => gate.beforeCall("test")).not.toThrow();

    // _reset() recovers the gate to normal
    gate._reset();

    // Now rate limiting is enforced again
    gate.beforeCall("test");
    gate.beforeCall("test");
    gate.beforeCall("test");
    expect(() => gate.beforeCall("test")).toThrow("Rate limit exceeded");

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Circuit-breaker gate
// ---------------------------------------------------------------------------

describe("CircuitBreakerGate — red-team", () => {
  it("cooldown doubles when breaker re-opens repeatedly", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const gate = new CircuitBreakerGate({
      threshold: 3, cooldownMs: 60_000, maxCooldownMs: 300_000,
    });

    // --- 1st open cycle ---
    gate.onError("test", new Error("e1"));
    gate.onError("test", new Error("e2"));
    gate.onError("test", new Error("e3"));
    expect(gate._isOpen()).toBe(true);

    // Wait past initial 60s cooldown
    vi.advanceTimersByTime(61_000);
    expect(gate._isOpen()).toBe(false);

    // beforeCall resets escalated cooldown back to base
    gate.beforeCall("test");

    // --- 2nd open cycle (cooldown should double) ---
    gate.onError("test", new Error("e4"));
    gate.onError("test", new Error("e5"));
    gate.onError("test", new Error("e6"));

    // Breaker is open with 120s cooldown (_openUntil ≈ 61000 + 60000 = 121000)
    vi.advanceTimersByTime(30_000); // now ≈ 91000
    expect(gate._isOpen()).toBe(true); // still in 120s window

    vi.advanceTimersByTime(31_000); // now ≈ 122000
    expect(gate._isOpen()).toBe(false); // past 120s cooldown ✓

    vi.useRealTimers();
  });

  it("recovers after cooldown — beforeCall no longer throws", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const gate = new CircuitBreakerGate({
      threshold: 3, cooldownMs: 60_000, maxCooldownMs: 300_000,
    });

    // Trip the breaker
    gate.onError("test", new Error("e1"));
    gate.onError("test", new Error("e2"));
    gate.onError("test", new Error("e3"));
    expect(() => gate.beforeCall("test")).toThrow(CircuitOpenError);

    // Wait past cooldown
    vi.advanceTimersByTime(61_000);

    // Should no longer throw
    expect(() => gate.beforeCall("test")).not.toThrow();

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Concurrent / parallel calls
// ---------------------------------------------------------------------------

describe("Gate — parallel calls", () => {
  it("RateLimitGate handles concurrent beforeCall", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const gate = new RateLimitGate({ windowMs: 1000, maxCalls: 100, selfFallbackThreshold: 0 });

    const calls = Array.from({ length: 50 }, () =>
      Promise.resolve().then(() => gate.beforeCall("test")),
    );
    const results = await Promise.all(calls);
    expect(results).toHaveLength(50);

    vi.useRealTimers();
  });

  it("CircuitBreakerGate handles concurrent beforeCall", async () => {
    vi.useFakeTimers();
    const gate = new CircuitBreakerGate({ threshold: 20, cooldownMs: 60_000 });

    const calls = Array.from({ length: 10 }, () =>
      Promise.resolve().then(() => gate.beforeCall("test")),
    );
    await expect(Promise.all(calls)).resolves.toHaveLength(10);

    vi.useRealTimers();
  });

  it("AuditGate handles concurrent afterCall", async () => {
    const gate = new AuditGate({ maxBufferSize: 100, intervalMs: 5000, sampleRate: 1.0 });

    const calls = Array.from({ length: 50 }, (_, i) =>
      Promise.resolve().then(() => gate.afterCall(`m${i}`, null, 1)),
    );
    await Promise.all(calls);
    expect(gate._bufferSize()).toBe(50);
    gate.dispose();
  });
});

// ---------------------------------------------------------------------------
// Boundary value tests
// ---------------------------------------------------------------------------

describe("RateLimitGate — boundary values", () => {
  it("windowMs=0 never rate-limits (bucket stays empty)", () => {
    const gate = new RateLimitGate({ windowMs: 0, maxCalls: 3, selfFallbackThreshold: 0 });

    // With windowMs=0: windowStart = now - 0 = now.
    // Only timestamps > now pass the filter, so the bucket is always pruned empty.
    gate.beforeCall("test");
    gate.beforeCall("test");
    gate.beforeCall("test");
    expect(() => gate.beforeCall("test")).not.toThrow();
    expect(() => gate.beforeCall("test")).not.toThrow();
  });

  it("maxCalls=0 rate-limits every call", () => {
    const gate = new RateLimitGate({ windowMs: 1000, maxCalls: 0, selfFallbackThreshold: 0 });

    // bucket.length >= 0 is always true, so every beforeCall throws
    expect(() => gate.beforeCall("test")).toThrow("Rate limit exceeded");
  });

  it("selfFallbackThreshold=0 disables self-fallback", () => {
    const gate = new RateLimitGate({
      windowMs: 60_000, maxCalls: 3, selfFallbackThreshold: 0,
    });

    // onError with threshold 0 is a no-op
    gate.onError("test", new Error("e"));
    gate.onError("test", new Error("e"));
    gate.onError("test", new Error("e"));

    // Rate limit still enforced normally
    gate.beforeCall("test");
    gate.beforeCall("test");
    gate.beforeCall("test");
    expect(() => gate.beforeCall("test")).toThrow("Rate limit exceeded");
  });
});
