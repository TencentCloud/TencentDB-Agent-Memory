/**
 * 注入管线统计模块用例。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordInjectionPipelineEnd,
  recordInjectionPipelineError,
  getInjectionStats,
  resetInjectionStats,
  injectionStatsToPrometheus,
} from "../common/injection-stats.js";

describe("injection-stats", () => {
  beforeEach(() => resetInjectionStats());

  it("按请求聚合块数与 hook 分布", () => {
    recordInjectionPipelineEnd([
      { hookId: "a", blockCount: 2, durationMs: 10 },
      { hookId: "b", blockCount: 1, durationMs: 5 },
      { hookId: "a", blockCount: 1, durationMs: 3, error: "boom" },
    ]);
    const s = getInjectionStats();
    expect(s.requests).toBe(1);
    expect(s.blocksInjected).toBe(4);
    expect(s.hooks).toBe(3);
    expect(s.hookMsTotal).toBe(18);
    expect(s.failedHooks).toBe(1);
    expect(s.byHook.a).toEqual({ blocks: 3, ms: 13, failures: 1 });
    expect(s.byHook.b).toEqual({ blocks: 1, ms: 5, failures: 0 });
  });

  it("管线错误计数", () => {
    recordInjectionPipelineError();
    expect(getInjectionStats().errors).toBe(1);
  });

  it("Prometheus 导出包含关键行", () => {
    recordInjectionPipelineEnd([{ hookId: "x", blockCount: 1, durationMs: 2 }]);
    const out = injectionStatsToPrometheus();
    expect(out).toContain("tdai_injection_requests_total 1");
    expect(out).toContain('tdai_injection_hook_blocks_total{hook="x"} 1');
  });
});
