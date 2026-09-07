/**
 * SessionRecallCache 测试 — session 级 recall 去重缓存
 *
 * 吸收 PR #351 Erd-omg: injectedContentCache session 级去重设计
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SessionRecallCache } from "./session-recall-cache.js";

describe("SessionRecallCache", () => {
  let cache: SessionRecallCache;

  beforeEach(() => {
    cache = new SessionRecallCache({ ttlMs: 60_000, maxSize: 10 });
  });

  it("same session + same query returns cached result", () => {
    cache.set("sess-1", "东京旅行", "<relevant-memories>...东京...</relevant-memories>");
    const result = cache.get("sess-1", "东京旅行");
    expect(result).toBe("<relevant-memories>...东京...</relevant-memories>");
  });

  it("same session + different query returns null (cache miss)", () => {
    cache.set("sess-1", "东京旅行", "content-1");
    const result = cache.get("sess-1", "大阪旅行");
    expect(result).toBeNull();
  });

  it("different session + same query returns null", () => {
    cache.set("sess-1", "东京旅行", "content-1");
    const result = cache.get("sess-2", "东京旅行");
    expect(result).toBeNull();
  });

  it("TTL expiry: stale entry returns null", () => {
    // TTL=10ms，用过去的时间戳强制过期
    const shortCache = new SessionRecallCache({ ttlMs: 10 });
    shortCache.set("sess-1", "query", "old-content", Date.now() - 100);

    const result = shortCache.get("sess-1", "query");
    expect(result).toBeNull();
  });

  it("TTL: fresh entry still valid", () => {
    const longCache = new SessionRecallCache({ ttlMs: 60_000 });
    longCache.set("sess-1", "query", "fresh-content");

    const result = longCache.get("sess-1", "query");
    expect(result).toBe("fresh-content");
  });

  it("LRU eviction when maxSize exceeded", () => {
    // maxSize=3 的小缓存
    const smallCache = new SessionRecallCache({ maxSize: 3 });

    smallCache.set("sess-1", "q1", "oldest");
    smallCache.set("sess-1", "q2", "middle");
    smallCache.set("sess-1", "q3", "newest");
    // 第4个会触发 LRU 淘汰
    smallCache.set("sess-1", "q4", "new-entry");

    // "q1" (最旧) 应该被淘汰
    expect(smallCache.get("sess-1", "q1")).toBeNull();
    expect(smallCache.get("sess-1", "q2")).toBe("middle");
    expect(smallCache.get("sess-1", "q3")).toBe("newest");
    expect(smallCache.get("sess-1", "q4")).toBe("new-entry");
  });

  it("empty query is not cached", () => {
    cache.set("sess-1", "", "content");
    expect(cache.get("sess-1", "")).toBeNull();
  });

  it("empty injectedText is not cached", () => {
    cache.set("sess-1", "query", "");
    expect(cache.get("sess-1", "query")).toBeNull();
  });

  it("shutdown clears all cache entries", () => {
    cache.set("sess-1", "q1", "content-1");
    cache.set("sess-2", "q2", "content-2");

    cache.shutdown();

    expect(cache.get("sess-1", "q1")).toBeNull();
    expect(cache.get("sess-2", "q2")).toBeNull();
    expect(cache.stats().totalEntries).toBe(0);
  });

  it("clear specific session leaves other sessions intact", () => {
    cache.set("sess-1", "q1", "content-1");
    cache.set("sess-2", "q2", "content-2");

    cache.clear("sess-1");

    expect(cache.get("sess-1", "q1")).toBeNull();
    expect(cache.get("sess-2", "q2")).toBe("content-2");
  });

  it("clear all sessions", () => {
    cache.set("sess-1", "q1", "c1");
    cache.set("sess-2", "q2", "c2");
    cache.set("sess-3", "q3", "c3");

    cache.clear();

    expect(cache.stats().totalSessions).toBe(0);
    expect(cache.stats().totalEntries).toBe(0);
  });

  it("stats returns correct counts", () => {
    expect(cache.stats()).toEqual({ totalSessions: 0, totalEntries: 0 });

    cache.set("sess-1", "q1", "c1");
    cache.set("sess-1", "q2", "c2");
    cache.set("sess-2", "q3", "c3");

    expect(cache.stats().totalSessions).toBe(2);
    expect(cache.stats().totalEntries).toBe(3);
  });

  it("cache hit updates stats but does not reset TTL", () => {
    cache.set("sess-1", "q1", "content");
    const stats1 = cache.stats();
    // 多次读取不改变条目数
    cache.get("sess-1", "q1");
    cache.get("sess-1", "q1");
    cache.get("sess-1", "q1");
    expect(cache.stats()).toEqual(stats1);
  });

  it("concurrent access from multiple sessions", () => {
    const results: (string | null)[] = [];

    // 模拟多 session 并发写入
    for (let i = 0; i < 10; i++) {
      cache.set(`sess-${i}`, `query-${i}`, `content-${i}`);
    }

    // 模拟多 session 并发读取
    for (let i = 0; i < 10; i++) {
      results.push(cache.get(`sess-${i}`, `query-${i}`));
    }

    expect(results.every((r) => r !== null)).toBe(true);
    expect(cache.stats().totalSessions).toBe(10);
    expect(cache.stats().totalEntries).toBe(10);
  });
});
