/**
 * Latency / throughput math shared by the write and query phases.
 *
 * Percentiles use the "nearest-rank" method on a sorted copy (samples are ms,
 * float). Keep it dependency-free so the bench runs from source via tsx.
 */

export interface LatencyStats {
  count: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  /**
   * p99.9 — the tail that write stalls live in. A majority-write pause blocks
   * only a handful of batches out of tens of thousands, so it is invisible at
   * p99 yet dominates `maxMs`; p999 is where it actually shows up.
   */
  p999Ms: number;
  maxMs: number;
  meanMs: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  // nearest-rank: rank = ceil(p/100 * N), 1-indexed
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

export function latencyStats(samplesMs: number[]): LatencyStats {
  if (samplesMs.length === 0) {
    return { count: 0, p50Ms: 0, p90Ms: 0, p95Ms: 0, p99Ms: 0, p999Ms: 0, maxMs: 0, meanMs: 0 };
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    p50Ms: round2(percentile(sorted, 50)),
    p90Ms: round2(percentile(sorted, 90)),
    p95Ms: round2(percentile(sorted, 95)),
    p99Ms: round2(percentile(sorted, 99)),
    p999Ms: round2(percentile(sorted, 99.9)),
    maxMs: round2(sorted[sorted.length - 1]),
    meanMs: round2(sum / sorted.length),
  };
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Ops per second given a count and a wall-clock duration in ms. */
export function perSecond(count: number, wallMs: number): number {
  if (wallMs <= 0) return 0;
  return round2((count / wallMs) * 1000);
}
