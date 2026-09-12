/**
 * 协议转换性能统计：各转换方向延迟分位数 + 上游 prompt 缓存命中率。
 *
 * 设计：
 *   - 进程内环形采样（每方向最多 MAX_SAMPLES 条），计算 p50/p95/p99；
 *   - 缓存命中按“请求是否带 cache_read/cached_tokens > 0”与“缓存 token 占比”统计；
 *   - 提供 Prometheus 文本导出（供 /metrics 端点），无第三方依赖；
 *   - 全部为内存写操作，单线程下无锁。
 */

export interface ConversionKindStats {
  count: number;
  totalMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface ProtocolStatsSnapshot {
  conversions: Record<string, ConversionKindStats>;
  streams: Record<string, number>;
  cache: {
    requests: number;
    cacheHitRequests: number;
    cacheHitRate: number;
    cachedTokens: number;
    inputTokens: number;
    cachedTokenRatio: number;
  };
}

const MAX_SAMPLES = 4096;
const DURATIONS = new Map<string, number[]>();
const DURATION_HEAD = new Map<string, number>();
const DURATION_COUNT = new Map<string, number>();
const STREAMS = new Map<string, number>();
const cache = { requests: 0, cacheHitRequests: 0, cachedTokens: 0, inputTokens: 0 };
/** 丢弃参数计数：key = `${kind}\u0000${param}`；param 只允许转换器内的固定名（metadata 聚合计数）。 */
const DROPPED = new Map<string, number>();

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** 记录一次非流式转换耗时（毫秒）。 */
export function recordConversion(kind: string, durationMs: number): void {
  let arr = DURATIONS.get(kind);
  if (!arr) {
    arr = new Array<number>(MAX_SAMPLES);
    DURATIONS.set(kind, arr);
    DURATION_HEAD.set(kind, 0);
    DURATION_COUNT.set(kind, 0);
  }
  let head = DURATION_HEAD.get(kind) ?? 0;
  let count = DURATION_COUNT.get(kind) ?? 0;
  arr[head] = durationMs;
  head = (head + 1) % MAX_SAMPLES;
  if (count < MAX_SAMPLES) count += 1;
  DURATION_HEAD.set(kind, head);
  DURATION_COUNT.set(kind, count);
}

/** 记录一个流式转换实例（只计数，不做每帧耗时）。 */
export function recordStream(kind: string): void {
  STREAMS.set(kind, (STREAMS.get(kind) ?? 0) + 1);
}

/** 记录一次“协议无对位参数”丢弃（无论调用方是否传 onDropped，均计入 /metrics）。 */
export function recordDrop(kind: string, param: string): void {
  const key = `${kind}\u0000${param}`;
  DROPPED.set(key, (DROPPED.get(key) ?? 0) + 1);
}

/**
 * 记录一次上游 usage 的缓存命中情况。
 * @param usage 已归一化的 usage：{ cached_tokens?, input_tokens? }（缓存 token 计数）
 */
export function recordCacheUsage(usage: { cached?: number; input?: number } | undefined): void {
  if (!usage) return;
  const cached = typeof usage.cached === "number" ? usage.cached : 0;
  const input = typeof usage.input === "number" ? usage.input : 0;
  cache.requests += 1;
  if (cached > 0) cache.cacheHitRequests += 1;
  cache.cachedTokens += cached;
  cache.inputTokens += input;
}

export function getProtocolStats(): ProtocolStatsSnapshot {
  const conversions: Record<string, ConversionKindStats> = {};
  for (const [kind, arr] of DURATIONS) {
    const count = DURATION_COUNT.get(kind) ?? 0;
    if (count === 0) continue;
    const sorted = arr.slice(0, count).sort((a, b) => a - b);
    conversions[kind] = {
      count,
      totalMs: sorted.reduce((a, b) => a + b, 0),
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
    };
  }
  const streams: Record<string, number> = {};
  for (const [kind, n] of STREAMS) streams[kind] = n;
  return {
    conversions,
    streams,
    cache: {
      requests: cache.requests,
      cacheHitRequests: cache.cacheHitRequests,
      cacheHitRate: cache.requests > 0 ? cache.cacheHitRequests / cache.requests : 0,
      cachedTokens: cache.cachedTokens,
      inputTokens: cache.inputTokens,
      cachedTokenRatio: cache.inputTokens > 0 ? cache.cachedTokens / cache.inputTokens : 0,
    },
  };
}

export function resetProtocolStats(): void {
  DURATIONS.clear();
  DURATION_HEAD.clear();
  DURATION_COUNT.clear();
  STREAMS.clear();
  DROPPED.clear();
  cache.requests = 0;
  cache.cacheHitRequests = 0;
  cache.cachedTokens = 0;
  cache.inputTokens = 0;
}

/** Prometheus 文本格式导出（summary 风格：count/sum/分位数）。 */
export function protocolStatsToPrometheus(): string {
  const lines: string[] = [];
  const snap = getProtocolStats();
  for (const [kind, s] of Object.entries(snap.conversions)) {
    const safe = kind.replace(/[^a-zA-Z0-9_]/g, "_");
    lines.push(`# TYPE tdai_conversion_duration_ms_${safe} summary`);
    lines.push(`tdai_conversion_duration_ms_${safe}_count ${s.count}`);
    lines.push(`tdai_conversion_duration_ms_${safe}_sum ${s.totalMs.toFixed(3)}`);
    lines.push(`tdai_conversion_duration_ms_${safe}{quantile="0.5"} ${s.p50Ms.toFixed(3)}`);
    lines.push(`tdai_conversion_duration_ms_${safe}{quantile="0.95"} ${s.p95Ms.toFixed(3)}`);
    lines.push(`tdai_conversion_duration_ms_${safe}{quantile="0.99"} ${s.p99Ms.toFixed(3)}`);
  }
  for (const [kind, n] of Object.entries(snap.streams)) {
    const safe = kind.replace(/[^a-zA-Z0-9_]/g, "_");
    lines.push(`tdai_conversion_stream_total{kind="${kind}"} ${n}`);
  }
  lines.push("# TYPE tdai_conversion_dropped_total counter");
  for (const [key, n] of DROPPED) {
    const sep = key.indexOf("\u0000");
    const dropKind = key.slice(0, sep);
    const param = key.slice(sep + 1).replace(/"/g, "");
    const safeKind = dropKind.replace(/[^a-zA-Z0-9_]/g, "_");
    lines.push(`tdai_conversion_dropped_total{kind="${safeKind}",param="${param}"} ${n}`);
  }
  lines.push(`# TYPE tdai_upstream_cache_hit_requests counter`);
  lines.push(`tdai_upstream_cache_hit_requests ${snap.cache.cacheHitRequests}`);
  lines.push(`tdai_upstream_cache_requests_total ${snap.cache.requests}`);
  lines.push(`tdai_upstream_cached_tokens_total ${snap.cache.cachedTokens}`);
  lines.push(`tdai_upstream_input_tokens_total ${snap.cache.inputTokens}`);
  return lines.join("\n") + "\n";
}
