import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StatusCache } from "./status-cache.js";

describe("StatusCache", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns cached value on second call within TTL", async () => {
    const fetch = vi.fn().mockResolvedValue(42);
    const cache = new StatusCache<number>(1000);

    const r1 = await cache.get(fetch);
    const r2 = await cache.get(fetch);

    expect(r1).toBe(42);
    expect(r2).toBe(42);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after TTL expires", async () => {
    const fetch = vi.fn().mockResolvedValue(1);
    const cache = new StatusCache<number>(1000);

    await cache.get(fetch);
    vi.advanceTimersByTime(1001);
    fetch.mockResolvedValue(2);
    const result = await cache.get(fetch);

    expect(result).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent calls into one fetch", async () => {
    let resolve!: (v: number) => void;
    const inflight = new Promise<number>((r) => { resolve = r; });
    const fetch = vi.fn().mockReturnValue(inflight);
    const cache = new StatusCache<number>(5000);

    // Fire three calls before the fetch resolves
    const [p1, p2, p3] = [cache.get(fetch), cache.get(fetch), cache.get(fetch)];
    resolve(99);
    const results = await Promise.all([p1, p2, p3]);

    expect(results).toEqual([99, 99, 99]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("invalidate forces re-fetch on next call", async () => {
    const fetch = vi.fn().mockResolvedValueOnce("a").mockResolvedValueOnce("b");
    const cache = new StatusCache<string>(60_000);

    await cache.get(fetch);
    cache.invalidate();
    const result = await cache.get(fetch);

    expect(result).toBe("b");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("isFresh reflects cache state correctly", async () => {
    const cache = new StatusCache<number>(1000);
    expect(cache.isFresh).toBe(false);

    await cache.get(() => Promise.resolve(1));
    expect(cache.isFresh).toBe(true);

    vi.advanceTimersByTime(1001);
    expect(cache.isFresh).toBe(false);
  });

  it("isFresh is false after invalidate", async () => {
    const cache = new StatusCache<number>(60_000);
    await cache.get(() => Promise.resolve(1));
    expect(cache.isFresh).toBe(true);

    cache.invalidate();
    expect(cache.isFresh).toBe(false);
  });

  it("propagates fetch errors without poisoning the cache", async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(7);
    const cache = new StatusCache<number>(5000);

    await expect(cache.get(fetch)).rejects.toThrow("boom");
    // Next call should retry, not serve a stale error
    const result = await cache.get(fetch);
    expect(result).toBe(7);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("ttl=0 never caches (always re-fetches)", async () => {
    const fetch = vi.fn().mockResolvedValue(1);
    const cache = new StatusCache<number>(0);

    await cache.get(fetch);
    await cache.get(fetch);

    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
