/**
 * 协议转换性能统计模块测试：分位数、环形上限、缓存命中、Prometheus 导出。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordConversion,
  recordStream,
  recordCacheUsage,
  getProtocolStats,
  resetProtocolStats,
  protocolStatsToPrometheus,
} from "../common/protocol-stats.js";

describe("protocol-stats", () => {
  beforeEach(() => resetProtocolStats());

  it("p50/p95/p99 与总和计算正确", () => {
    for (let i = 1; i <= 100; i++) recordConversion("x", i);
    const s = getProtocolStats().conversions.x;
    expect(s.count).toBe(100);
    expect(s.totalMs).toBe(5050);
    expect(s.p50Ms).toBe(50);
    expect(s.p95Ms).toBe(95);
    expect(s.p99Ms).toBe(99);
  });

  it("环形采样上限 4096", () => {
    for (let i = 0; i < 5000; i++) recordConversion("y", i);
    expect(getProtocolStats().conversions.y.count).toBe(4096);
  });

  it("缓存命中率与缓存 token 占比", () => {
    recordCacheUsage({ cached: 100, input: 1000 });
    recordCacheUsage({ cached: 0, input: 2000 });
    recordCacheUsage(undefined);
    const c = getProtocolStats().cache;
    expect(c.requests).toBe(2);
    expect(c.cacheHitRequests).toBe(1);
    expect(c.cacheHitRate).toBeCloseTo(0.5);
    expect(c.cachedTokens).toBe(100);
    expect(c.inputTokens).toBe(3000);
    expect(c.cachedTokenRatio).toBeCloseTo(100 / 3000);
  });

  it("Prometheus 文本导出", () => {
    recordConversion("a_b", 1.5);
    recordStream("a_to_b");
    recordCacheUsage({ cached: 10, input: 100 });
    const out = protocolStatsToPrometheus();
    expect(out).toContain('tdai_conversion_duration_ms_a_b{quantile="0.95"} 1.500');
    expect(out).toContain('tdai_conversion_stream_total{kind="a_to_b"} 1');
    expect(out).toContain("tdai_upstream_cache_hit_requests 1");
  });
});
