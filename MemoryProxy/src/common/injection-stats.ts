/**
 * 注入管线的轻量统计（进程内）：请求数、注入块数、按 hook 分布、失败数。
 */

export interface InjectionStatsSnapshot {
  requests: number;
  errors: number;
  blocksInjected: number;
  hooks: number;
  hookMsTotal: number;
  failedHooks: number;
  byHook: Record<string, { blocks: number; ms: number; failures: number }>;
}

const stats: InjectionStatsSnapshot = {
  requests: 0,
  errors: 0,
  blocksInjected: 0,
  hooks: 0,
  hookMsTotal: 0,
  failedHooks: 0,
  byHook: {},
};

export interface InjectionHookSummary {
  hookId: string;
  blockCount: number;
  durationMs: number;
  error?: string;
}

export function recordInjectionPipelineEnd(results: InjectionHookSummary[]): void {
  stats.requests += 1;
  stats.hooks += results.length;
  for (const r of results) {
    stats.blocksInjected += r.blockCount;
    stats.hookMsTotal += r.durationMs;
    const entry = (stats.byHook[r.hookId] ??= { blocks: 0, ms: 0, failures: 0 });
    entry.blocks += r.blockCount;
    entry.ms += r.durationMs;
    if (r.error) {
      stats.failedHooks += 1;
      entry.failures += 1;
    }
  }
}

export function recordInjectionPipelineError(): void {
  stats.errors += 1;
}

export function getInjectionStats(): InjectionStatsSnapshot {
  return {
    ...stats,
    byHook: Object.fromEntries(
      Object.entries(stats.byHook).map(([k, v]) => [k, { ...v }]),
    ),
  };
}

export function resetInjectionStats(): void {
  stats.requests = 0;
  stats.errors = 0;
  stats.blocksInjected = 0;
  stats.hooks = 0;
  stats.hookMsTotal = 0;
  stats.failedHooks = 0;
  stats.byHook = {};
}

export function injectionStatsToPrometheus(): string {
  const lines: string[] = [];
  lines.push("# TYPE tdai_injection_requests_total counter");
  lines.push(`tdai_injection_requests_total ${stats.requests}`);
  lines.push("# TYPE tdai_injection_errors_total counter");
  lines.push(`tdai_injection_errors_total ${stats.errors}`);
  lines.push("# TYPE tdai_injection_blocks_total counter");
  lines.push(`tdai_injection_blocks_total ${stats.blocksInjected}`);
  lines.push("# TYPE tdai_injection_hooks_total counter");
  lines.push(`tdai_injection_hooks_total ${stats.hooks}`);
  lines.push("# TYPE tdai_injection_failed_hooks_total counter");
  lines.push(`tdai_injection_failed_hooks_total ${stats.failedHooks}`);
  for (const [id, v] of Object.entries(stats.byHook)) {
    const safe = id.replace(/[^a-zA-Z0-9_]/g, "_");
    lines.push(`tdai_injection_hook_blocks_total{hook="${id}"} ${v.blocks}`);
    lines.push(`tdai_injection_hook_ms_total{hook="${id}"} ${v.ms}`);
  }
  return lines.join("\n") + "\n";
}
