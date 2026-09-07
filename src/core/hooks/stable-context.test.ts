import { describe, expect, it } from "vitest";

import { StableRecallContextCache, hashContent } from "./stable-context.js";

const S = "session-a";

describe("hashContent", () => {
  it("is deterministic and 16 hex chars", () => {
    expect(hashContent("abc")).toBe(hashContent("abc"));
    expect(hashContent("abc")).toMatch(/^[0-9a-f]{16}$/);
    expect(hashContent("abc")).not.toBe(hashContent("abd"));
  });
});

describe("StableRecallContextCache", () => {
  it("freezes the first candidate and reports a miss", () => {
    const cache = new StableRecallContextCache();
    const r = cache.resolve(S, "persona-v1");
    expect(r).toEqual({ content: "persona-v1", cacheHit: false, drifted: false });
    expect(cache.has(S)).toBe(true);
  });

  it("returns identical bytes when the candidate drifts, and counts the drift", () => {
    const cache = new StableRecallContextCache();
    cache.resolve(S, "persona-v1");

    const r2 = cache.resolve(S, "persona-v2-REWRITTEN-BY-L3");
    expect(r2.content).toBe("persona-v1"); // frozen bytes win
    expect(r2.cacheHit).toBe(true);
    expect(r2.drifted).toBe(true);

    const r3 = cache.resolve(S, "persona-v3");
    expect(r3.content).toBe("persona-v1");
    expect(cache.peek(S)?.driftDetected).toBe(2);
  });

  it("survives an undefined candidate after a freeze (recall-timeout resilience)", () => {
    const cache = new StableRecallContextCache();
    cache.resolve(S, "persona-v1");
    const r = cache.resolve(S, undefined);
    expect(r).toEqual({ content: "persona-v1", cacheHit: true, drifted: false });
  });

  it("returns undefined (no freeze) when the first candidate is undefined", () => {
    const cache = new StableRecallContextCache();
    const r = cache.resolve(S, undefined);
    expect(r).toEqual({ content: undefined, cacheHit: false, drifted: false });
    expect(cache.has(S)).toBe(false);
    // A later defined candidate freezes normally
    expect(cache.resolve(S, "late").content).toBe("late");
    expect(cache.has(S)).toBe(true);
  });

  it("identical candidate is a clean cache hit (no drift)", () => {
    const cache = new StableRecallContextCache();
    cache.resolve(S, "same");
    const r = cache.resolve(S, "same");
    expect(r).toEqual({ content: "same", cacheHit: true, drifted: false });
    expect(cache.peek(S)?.driftDetected).toBe(0);
  });

  it("freeze() replaces content explicitly", () => {
    const cache = new StableRecallContextCache();
    cache.resolve(S, "v1");
    cache.freeze(S, "v2-folded-with-memories");
    expect(cache.resolve(S, undefined).content).toBe("v2-folded-with-memories");
  });

  it("expires after the idle TTL and re-freezes the next candidate", () => {
    const cache = new StableRecallContextCache({ ttlMs: 1000 });
    const t0 = 1_000_000;
    cache.resolve(S, "v1", t0);
    // Within TTL → frozen bytes
    expect(cache.resolve(S, "v2", t0 + 999).content).toBe("v1");
    // TTL is sliding — access at t0+999 extended it
    expect(cache.has(S, t0 + 1500)).toBe(true);
    // Idle past TTL → expired, new candidate freezes fresh
    const r = cache.resolve(S, "v3", t0 + 999 + 1001);
    expect(r).toEqual({ content: "v3", cacheHit: false, drifted: false });
  });

  it("sweep() evicts idle sessions and enforces the LRU cap", () => {
    const cache = new StableRecallContextCache({ ttlMs: 1000, maxSessions: 2 });
    const t0 = 5_000_000;
    cache.resolve("s1", "c1", t0);
    cache.resolve("s2", "c2", t0 + 10);
    cache.resolve("s3", "c3", t0 + 20);
    expect(cache.size).toBe(3);

    // Cap: oldest lastAccess (s1) evicted
    cache.sweep(t0 + 30);
    expect(cache.size).toBe(2);
    expect(cache.has("s1", t0 + 30)).toBe(false);
    expect(cache.has("s2", t0 + 30)).toBe(true);
    expect(cache.has("s3", t0 + 30)).toBe(true);

    // TTL: everything idle > 1000ms goes
    cache.sweep(t0 + 5000);
    expect(cache.size).toBe(0);
  });

  it("keeps sessions independent", () => {
    const cache = new StableRecallContextCache();
    cache.resolve("a", "content-a");
    cache.resolve("b", "content-b");
    expect(cache.resolve("a", "zzz").content).toBe("content-a");
    expect(cache.resolve("b", "zzz").content).toBe("content-b");
  });

  it("clear() drops all sessions", () => {
    const cache = new StableRecallContextCache();
    cache.resolve("a", "1");
    cache.resolve("b", "2");
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.has("a")).toBe(false);
  });
});
