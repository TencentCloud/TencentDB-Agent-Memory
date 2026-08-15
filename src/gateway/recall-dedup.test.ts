/**
 * Tests for SessionRecallDedup — session-level change detection for the
 * Gateway `/recall` endpoint (issue #120 / #523).
 *
 * Core semantic under test: dedup compares against the session's *most recent*
 * response (change detection), NOT "seen-before, never again". A context that
 * changed and then changed back must be served again.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SessionRecallDedup, fingerprintOf, RECALL_DEDUP_DEFAULTS } from "./recall-dedup.js";

const CONTEXT_A = "<user-persona>Alice</user-persona>\n\n<memory-tools-guide>tools</memory-tools-guide>";
const CONTEXT_B = "<user-persona>Bob</user-persona>\n\n<memory-tools-guide>tools</memory-tools-guide>";

describe("SessionRecallDedup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a plain passthrough when disabled (default)", () => {
    const dedup = new SessionRecallDedup();
    const first = dedup.evaluate("s1", CONTEXT_A);
    const second = dedup.evaluate("s1", CONTEXT_A);

    expect(first).toEqual({ deduplicated: false, context: CONTEXT_A });
    expect(second).toEqual({ deduplicated: false, context: CONTEXT_A });
    expect(dedup.size).toBe(0); // nothing cached while disabled
    expect(dedup.hits).toBe(0);
  });

  it("serves the first occurrence in full, skips the byte-identical repeat", () => {
    const dedup = new SessionRecallDedup({ enabled: true });

    const first = dedup.evaluate("s1", CONTEXT_A);
    const second = dedup.evaluate("s1", CONTEXT_A);

    expect(first).toEqual({ deduplicated: false, context: CONTEXT_A });
    expect(second).toEqual({ deduplicated: true, context: "" });
    expect(dedup.hits).toBe(1);
    expect(dedup.misses).toBe(1);
  });

  it("keeps different sessions independent", () => {
    const dedup = new SessionRecallDedup({ enabled: true });

    expect(dedup.evaluate("s1", CONTEXT_A)).toEqual({ deduplicated: false, context: CONTEXT_A });
    expect(dedup.evaluate("s2", CONTEXT_A)).toEqual({ deduplicated: false, context: CONTEXT_A });
    expect(dedup.evaluate("s1", CONTEXT_A)).toEqual({ deduplicated: true, context: "" });
    expect(dedup.evaluate("s2", CONTEXT_A)).toEqual({ deduplicated: true, context: "" });
    expect(dedup.size).toBe(2);
  });

  it("re-serves after a change, and re-deduplicates only once the latest baseline repeats (change detection, not seen-before)", () => {
    const dedup = new SessionRecallDedup({ enabled: true });

    // A → serve
    expect(dedup.evaluate("s1", CONTEXT_A)).toEqual({ deduplicated: false, context: CONTEXT_A });
    // A → skip
    expect(dedup.evaluate("s1", CONTEXT_A)).toEqual({ deduplicated: true, context: "" });
    // scene/persona changes to B → serve again
    expect(dedup.evaluate("s1", CONTEXT_B)).toEqual({ deduplicated: false, context: CONTEXT_B });
    // B → skip
    expect(dedup.evaluate("s1", CONTEXT_B)).toEqual({ deduplicated: true, context: "" });
    // back to A: differs from the most recent response (B) → must be served,
    // even though A was seen earlier in the session
    expect(dedup.evaluate("s1", CONTEXT_A)).toEqual({ deduplicated: false, context: CONTEXT_A });
  });

  it("never caches or deduplicates an empty context", () => {
    const dedup = new SessionRecallDedup({ enabled: true });

    const first = dedup.evaluate("s1", "");
    const second = dedup.evaluate("s1", "");

    expect(first).toEqual({ deduplicated: false, context: "" });
    expect(second).toEqual({ deduplicated: false, context: "" });
    expect(dedup.size).toBe(0);
  });

  it("re-serves after TTL expiry without access", () => {
    vi.useFakeTimers();
    const dedup = new SessionRecallDedup({ enabled: true, ttlMs: 60_000 });

    vi.setSystemTime(1_000);
    expect(dedup.evaluate("s1", CONTEXT_A)).toEqual({ deduplicated: false, context: CONTEXT_A });

    // Same session, same content, still within TTL → deduplicated
    vi.setSystemTime(61_000);
    expect(dedup.evaluate("s1", CONTEXT_A)).toEqual({ deduplicated: true, context: "" });

    // Last access was 61s ago, TTL is 60s → entry expired, serve again
    vi.setSystemTime(121_001);
    expect(dedup.evaluate("s1", CONTEXT_A)).toEqual({ deduplicated: false, context: CONTEXT_A });
  });

  it("evicts the least-recently-used session when maxEntries overflows", () => {
    const dedup = new SessionRecallDedup({ enabled: true, maxEntries: 2 });

    expect(dedup.evaluate("s1", CONTEXT_A)).toEqual({ deduplicated: false, context: CONTEXT_A });
    expect(dedup.evaluate("s2", CONTEXT_A)).toEqual({ deduplicated: false, context: CONTEXT_A });
    // s1 becomes the most-recently-used entry
    expect(dedup.evaluate("s1", CONTEXT_A)).toEqual({ deduplicated: true, context: "" });

    // Overflow evicts s2 (the LRU entry), not s1
    expect(dedup.evaluate("s3", CONTEXT_A)).toEqual({ deduplicated: false, context: CONTEXT_A });
    expect(dedup.size).toBe(2);

    // s2 was evicted → served in full again
    expect(dedup.evaluate("s2", CONTEXT_A)).toEqual({ deduplicated: false, context: CONTEXT_A });
  });

  it("forgets a session on clearSession (session/end)", () => {
    const dedup = new SessionRecallDedup({ enabled: true });

    expect(dedup.evaluate("s1", CONTEXT_A)).toEqual({ deduplicated: false, context: CONTEXT_A });
    expect(dedup.evaluate("s1", CONTEXT_A)).toEqual({ deduplicated: true, context: "" });

    dedup.clearSession("s1");
    expect(dedup.size).toBe(0);

    expect(dedup.evaluate("s1", CONTEXT_A)).toEqual({ deduplicated: false, context: CONTEXT_A });
  });

  it("evictExpired reports and removes only stale entries", () => {
    vi.useFakeTimers();
    const dedup = new SessionRecallDedup({ enabled: true, ttlMs: 60_000 });

    vi.setSystemTime(1_000);
    dedup.evaluate("s1", CONTEXT_A);
    dedup.evaluate("s2", CONTEXT_B);

    // Both entries last accessed at t=1s; now 70s later → both stale.
    vi.setSystemTime(70_001);
    const removed = dedup.evictExpired(Date.now());

    expect(removed).toBe(2);
    expect(dedup.size).toBe(0);
  });

  it("counts hits and misses separately", () => {
    const dedup = new SessionRecallDedup({ enabled: true });

    dedup.evaluate("s1", CONTEXT_A); // miss
    dedup.evaluate("s1", CONTEXT_A); // hit
    dedup.evaluate("s2", CONTEXT_B); // miss
    dedup.evaluate("s2", CONTEXT_B); // hit

    expect(dedup.hits).toBe(2);
    expect(dedup.misses).toBe(2);
  });
});

describe("fingerprintOf", () => {
  it("is stable for identical input and distinct for different input", () => {
    expect(fingerprintOf(CONTEXT_A)).toBe(fingerprintOf(CONTEXT_A));
    expect(fingerprintOf(CONTEXT_A)).not.toBe(fingerprintOf(CONTEXT_B));
    expect(fingerprintOf(CONTEXT_A)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("distinguishes byte-level differences (trailing newline)", () => {
    expect(fingerprintOf("abc")).not.toBe(fingerprintOf("abc\n"));
  });
});

describe("RECALL_DEDUP_DEFAULTS", () => {
  it("defaults to disabled with a 1h TTL and 1000-entry cap", () => {
    expect(RECALL_DEDUP_DEFAULTS).toEqual({ enabled: false, ttlMs: 3_600_000, maxEntries: 1000 });
  });
});
