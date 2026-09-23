/**
 * Concurrent batched writer.
 *
 * A fixed pool of `concurrency` workers pulls batch slots off a shared cursor
 * (JS is single-threaded, so the increment is atomic) and issues one
 * `insertMany(docs, { ordered: true })` per slot. Each slot's wall time is one
 * latency sample. batch=1 degenerates to a single-doc insert, so batch tiers
 * are directly comparable at the same concurrency.
 *
 * Docs are generated lazily inside the worker (never all at once) so the 100M
 * phase stays within memory.
 */

import type { Collection } from "mongodb";
import type { L0Doc } from "../../src/core/store/mongodb/doc-mappers.js";
import { latencyStats, perSecond, type LatencyStats } from "./metrics.js";

/** One point on the write-throughput-over-time curve (see `--sample-ms`). */
export interface ThroughputSample {
  /** Wall-clock ms since the insert started (this bucket's end). */
  tMs: number;
  /** Cumulative docs inserted at this point. */
  docs: number;
  /** Instantaneous docs/s over the last sampling interval. */
  intervalDocsPerSec: number;
  /** Average docs/s since the insert started. */
  cumulativeDocsPerSec: number;
}

/**
 * Write-stall accounting, measured two independent ways so the answer to "did
 * stalling stop?" does not rest on a single view.
 *
 * `slowBatches` is the client's own latency tail: individual `insertMany` calls
 * that blocked far longer than normal. `zeroWindows` is the coarser but
 * unambiguous signal — a whole sampling interval in which *no* batch completed
 * across *all* workers, which is what showed up as `inst=0/s` in the logs.
 * A clean run has zero of both.
 */
export interface StallStats {
  /** Latency above which a batch counts as stalled (ms). */
  slowBatchThresholdMs: number;
  /** Batches slower than the threshold. */
  slowBatches: number;
  /** Those batches as a share of all batches (%). */
  slowBatchPct: number;
  /** Longest single batch (ms) — same value as `batchLatency.maxMs`, surfaced here for convenience. */
  longestBatchMs: number;
  /** Sampling windows in which zero docs completed. */
  zeroWindows: number;
  /** Sampling windows below 10% of the run's mean throughput (includes `zeroWindows`). */
  degradedWindows: number;
  /** Wall-clock offsets (ms) of the zero-throughput windows, for server-side correlation. */
  zeroWindowAtMs: number[];
}

export interface InsertResult {
  docs: number;
  batch: number;
  concurrency: number;
  wallMs: number;
  docsPerSec: number;
  batchesPerSec: number;
  errors: number;
  /** Per-batch insert latency. */
  batchLatency: LatencyStats;
  /** Write-throughput time series (empty if the run was shorter than one interval). */
  samples: ThroughputSample[];
  /** Explicit stall accounting — the headline "is it fixed?" number. */
  stalls: StallStats;
}

/**
 * A batch is "stalled" when it takes more than this multiple of the run's
 * median. Relative rather than absolute so the same rule works whether p50 is
 * 100ms (batch=1000) or 40ms (batch=1).
 */
const STALL_P50_MULTIPLE = 20;
/** …but never flag anything under this, so a fast, jittery run stays clean. */
const STALL_FLOOR_MS = 5_000;

function summarizeStalls(
  latencies: number[],
  stats: LatencyStats,
  samples: ThroughputSample[],
  meanDocsPerSec: number,
): StallStats {
  const threshold = Math.max(STALL_FLOOR_MS, stats.p50Ms * STALL_P50_MULTIPLE);
  const slow = latencies.filter((l) => l > threshold).length;
  const zero = samples.filter((s) => s.intervalDocsPerSec === 0);
  const degraded = samples.filter((s) => s.intervalDocsPerSec < meanDocsPerSec * 0.1);
  return {
    slowBatchThresholdMs: Math.round(threshold),
    slowBatches: slow,
    slowBatchPct: latencies.length ? Math.round((slow / latencies.length) * 1e4) / 100 : 0,
    longestBatchMs: stats.maxMs,
    zeroWindows: zero.length,
    degradedWindows: degraded.length,
    zeroWindowAtMs: zero.map((s) => s.tMs),
  };
}

export interface InsertParams {
  coll: Collection;
  totalDocs: number;
  batch: number;
  concurrency: number;
  gen: (globalIndex: number) => L0Doc;
  onProgress?: (done: number, total: number) => void;
  progressEvery?: number;
  /** Emit a throughput sample every N ms. 0/undefined disables sampling. */
  sampleEveryMs?: number;
  /** Called for each throughput sample (live QPS logging). */
  onSample?: (sample: ThroughputSample) => void;
}

export async function runInsert(params: InsertParams): Promise<InsertResult> {
  const { coll, totalDocs, batch, concurrency, gen } = params;
  const progressEvery = params.progressEvery ?? Math.max(1, Math.floor(totalDocs / 20));

  const latencies: number[] = [];
  let nextStart = 0;
  let done = 0;
  let errors = 0;
  let lastProgressMark = 0;

  const wall0 = performance.now();

  // Throughput-over-time sampler: snapshot `done` every `sampleEveryMs` and
  // derive instantaneous docs/s from the delta since the previous snapshot.
  const samples: ThroughputSample[] = [];
  let sampler: ReturnType<typeof setInterval> | undefined;
  const sampleEveryMs = params.sampleEveryMs ?? 0;
  if (sampleEveryMs > 0) {
    let lastNow = wall0;
    let lastDone = 0;
    sampler = setInterval(() => {
      const now = performance.now();
      const intervalDocs = done - lastDone;
      const intervalMs = now - lastNow;
      const sample: ThroughputSample = {
        tMs: Math.round(now - wall0),
        docs: done,
        intervalDocsPerSec: perSecond(intervalDocs, intervalMs),
        cumulativeDocsPerSec: perSecond(done, now - wall0),
      };
      samples.push(sample);
      params.onSample?.(sample);
      lastNow = now;
      lastDone = done;
    }, sampleEveryMs);
    // Don't let the interval keep the event loop alive on its own.
    sampler.unref?.();
  }

  async function worker(): Promise<void> {
    for (;;) {
      const start = nextStart;
      if (start >= totalDocs) return;
      const size = Math.min(batch, totalDocs - start);
      nextStart = start + size;

      const docs: L0Doc[] = new Array(size);
      for (let i = 0; i < size; i++) docs[i] = gen(start + i);

      const t0 = performance.now();
      try {
        await coll.insertMany(docs as never[], { ordered: true });
      } catch (e) {
        errors++;
        // Ordered insert reports the first failing doc; the batch is partial.
        // Log once-ish and keep going so one bad slot doesn't abort the run.
        if (errors <= 5) console.warn(`[insert] batch @${start} failed:`, (e as Error).message);
      }
      const dt = performance.now() - t0;
      latencies.push(dt);

      done += size;
      if (params.onProgress && done - lastProgressMark >= progressEvery) {
        lastProgressMark = done;
        params.onProgress(done, totalDocs);
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => worker());
  try {
    await Promise.all(workers);
  } finally {
    if (sampler) clearInterval(sampler);
  }

  const wallMs = performance.now() - wall0;
  const batchLatency = latencyStats(latencies);
  const docsPerSec = perSecond(totalDocs, wallMs);
  return {
    docs: totalDocs,
    batch,
    concurrency,
    wallMs: Math.round(wallMs),
    docsPerSec,
    batchesPerSec: perSecond(latencies.length, wallMs),
    errors,
    batchLatency,
    samples,
    stalls: summarizeStalls(latencies, batchLatency, samples, docsPerSec),
  };
}
