/**
 * 上游能力探测的运行指标。
 *
 * 与 protocol-stats.ts 分开记：那边统计的是请求级的协议转换指标，
 * 这里统计的是探测级事件（跑了几轮、缓存命中几次、能力变了几次），
 * 两者的生命周期和排查用途不同。
 */

const state = {
  runs: 0,
  failures: 0,
  cacheHits: 0,
  cacheMisses: 0,
  changes: new Map<string, number>(),
};

export function recordProbeRun(): void {
  state.runs++;
}

/** 三个端点全部探不通（可能是上游临时不可用，而不是真的不支持）。 */
export function recordProbeFailure(): void {
  state.failures++;
}

export function recordProbeCacheHit(): void {
  state.cacheHits++;
}

export function recordProbeCacheMiss(): void {
  state.cacheMisses++;
}

export function recordProbeChange(agent: string): void {
  state.changes.set(agent, (state.changes.get(agent) ?? 0) + 1);
}

export function resetProbeStats(): void {
  state.runs = 0;
  state.failures = 0;
  state.cacheHits = 0;
  state.cacheMisses = 0;
  state.changes.clear();
}

/** Prometheus 文本格式；agent 标签值做转义，避免配置里的名字破坏格式。 */
export function probeStatsToPrometheus(): string {
  const label = (agent: string): string => agent.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const lines = [
    "# HELP tdai_upstream_probe_runs_total 上游能力探测执行轮次",
    "# TYPE tdai_upstream_probe_runs_total counter",
    `tdai_upstream_probe_runs_total ${state.runs}`,
    "# HELP tdai_upstream_probe_failures_total 三端点全部不通的探测次数",
    "# TYPE tdai_upstream_probe_failures_total counter",
    `tdai_upstream_probe_failures_total ${state.failures}`,
    "# HELP tdai_upstream_probe_cache_hits_total 直接复用缓存跳过探测的次数",
    "# TYPE tdai_upstream_probe_cache_hits_total counter",
    `tdai_upstream_probe_cache_hits_total ${state.cacheHits}`,
    "# HELP tdai_upstream_probe_cache_misses_total 缓存未命中而真实探测的次数",
    "# TYPE tdai_upstream_probe_cache_misses_total counter",
    `tdai_upstream_probe_cache_misses_total ${state.cacheMisses}`,
    "# HELP tdai_upstream_probe_changes_total 上游能力发生变化（端点出现或消失）的次数",
    "# TYPE tdai_upstream_probe_changes_total counter",
  ];
  if (state.changes.size === 0) {
    lines.push('tdai_upstream_probe_changes_total{agent=""} 0');
  } else {
    for (const [agent, count] of [...state.changes.entries()].sort()) {
      lines.push(`tdai_upstream_probe_changes_total{agent="${label(agent)}"} ${count}`);
    }
  }
  return lines.join("\n");
}
