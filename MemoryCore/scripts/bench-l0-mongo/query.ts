/**
 * Business-shaped read benchmark. Drives the real production query methods on
 * `MongoMemoryStore` (same code paths the gateway uses), so the numbers reflect
 * index usage, isolation push-down and BM25 normalization — not a bespoke query.
 *
 * Query shapes (aligned to the gateway):
 *  - searchL0Fts   : `$search` BM25 (jieba query + isolation filter, limit 5)
 *  - sessionReplay : queryL0Paginated by session_id (a conversation replay page)
 *  - queryL0ForL1  : session_key + recorded_at ordering, limit 50 (L1 extractor)
 *  - paginated     : isolation-scoped queryL0Paginated (+ its countDocuments)
 *  - countL0       : countL0 vs estimatedDocumentCount
 * Plus an empty-result BM25 probe (missText) to price the no-hit path.
 */

import type { MongoMemoryStore } from "../../src/core/store/mongodb/memory-store.js";
import { buildFtsQuery } from "../../src/core/store/tokenize.js";
import { latencyStats, perSecond, type LatencyStats } from "./metrics.js";
import type { QueryTarget } from "./generate.js";

export interface QueryStat {
  n: number;
  qps: number;
  /** In-flight requests used to produce `qps` (1 = serial, RTT-bound). */
  concurrency: number;
  /** Rows returned by the last iteration (sanity that the query actually hit). */
  lastHits: number;
  latency: LatencyStats;
  /** Failed iterations (counted in `n`, latency still recorded). */
  errors: number;
}

export type QueryReport = Record<string, QueryStat>;

/**
 * Run `iterations` calls spread over `concurrency` in-flight workers.
 *
 * Serial (`concurrency=1`) makes `qps` just `1000/latency`, which on a
 * cross-region link is dominated by RTT and says nothing about server capacity.
 * Running several requests in flight amortizes that fixed per-op RTT, so `qps`
 * becomes a real aggregate-throughput number; latency percentiles stay
 * per-request and will rise once the server saturates.
 */
async function timeIt(
  iterations: number,
  concurrency: number,
  fn: () => Promise<number>,
): Promise<QueryStat> {
  const lat: number[] = [];
  let lastHits = 0;
  let errors = 0;
  let next = 0;
  const wall0 = performance.now();

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= iterations) return;
      const t0 = performance.now();
      try {
        lastHits = await fn();
      } catch {
        errors++;
      }
      lat.push(performance.now() - t0);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  const wallMs = performance.now() - wall0;
  return {
    n: iterations,
    qps: perSecond(iterations, wallMs),
    concurrency: Math.max(1, concurrency),
    lastHits,
    latency: latencyStats(lat),
    errors,
  };
}

/**
 * Poll BM25 until the freshly-inserted data is visible via `$search` (mongot is
 * eventually consistent). Returns ms waited, or -1 if it never became visible.
 */
export async function waitForFtsVisibility(
  store: MongoMemoryStore,
  target: QueryTarget,
  timeoutMs = 30_000,
): Promise<number> {
  const q = buildFtsQuery(target.hitText);
  if (!q) return -1;
  const t0 = performance.now();
  for (;;) {
    let hits = 0;
    try {
      hits = (await store.searchL0Fts(q, 5, { teamId: target.teamId })).length;
    } catch {
      hits = 0;
    }
    if (hits > 0) return Math.round(performance.now() - t0);
    if (performance.now() - t0 > timeoutMs) return -1;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * The business-shaped read operations, as a name → thunk map. Shared by the
 * single-pass benchmark and the concurrency sweep so both drive identical
 * production code paths.
 */
export function queryOps(
  store: MongoMemoryStore,
  target: QueryTarget,
): Record<string, () => Promise<number>> {
  const hitQuery = buildFtsQuery(target.hitText) ?? target.hitText;
  const missQuery = buildFtsQuery(target.missText) ?? target.missText;

  return {
    searchL0Fts: async () => {
      const rows = await store.searchL0Fts(hitQuery, 5, {
        teamId: target.teamId,
        userId: target.userId,
        agentId: target.agentId,
      });
      return rows.length;
    },
    searchL0FtsEmpty: async () => {
      const rows = await store.searchL0Fts(missQuery, 5, { teamId: target.teamId });
      return rows.length;
    },
    sessionReplay: async () => {
      if (!store.queryL0Paginated) return 0;
      const res = await store.queryL0Paginated({ sessionId: target.sessionId, limit: 20, offset: 0 });
      return res.rows.length;
    },
    queryL0ForL1: async () => {
      const rows = await store.queryL0ForL1(target.sessionKey, undefined, 50);
      return rows.length;
    },
    paginated: async () => {
      if (!store.queryL0Paginated) return 0;
      const res = await store.queryL0Paginated({
        teamId: target.teamId,
        userId: target.userId,
        agentId: target.agentId,
        limit: 20,
        offset: 0,
      });
      return res.rows.length;
    },
    countL0: async () =>
      store.countL0({ teamId: target.teamId, userId: target.userId, agentId: target.agentId }),
  };
}

export async function runQueries(
  store: MongoMemoryStore,
  target: QueryTarget,
  iterations: number,
  concurrency = 1,
): Promise<QueryReport> {
  const ops = queryOps(store, target);
  const report: QueryReport = {};
  for (const [name, fn] of Object.entries(ops)) {
    report[name] = await timeIt(iterations, concurrency, fn);
  }
  return report;
}

/** One concurrency step for a single query type. */
export interface QuerySweepStep extends QueryStat {
  name: string;
}

/**
 * Sweep concurrency per query type to find the read throughput ceiling.
 *
 * Where `qps` stops scaling with concurrency (and latency starts climbing) is
 * the server-side limit; below that point the link's fixed RTT — not the
 * database — is what caps a single client.
 */
export async function runQuerySweep(
  store: MongoMemoryStore,
  target: QueryTarget,
  iterationsPerStep: number,
  concurrencies: number[],
  onStep?: (step: QuerySweepStep) => void,
  only?: string[],
): Promise<Record<string, QuerySweepStep[]>> {
  const all = queryOps(store, target);
  const ops =
    only && only.length > 0
      ? Object.fromEntries(Object.entries(all).filter(([n]) => only.includes(n)))
      : all;
  const out: Record<string, QuerySweepStep[]> = {};
  for (const [name, fn] of Object.entries(ops)) {
    out[name] = [];
    for (const c of concurrencies) {
      const stat = await timeIt(iterationsPerStep, c, fn);
      const step: QuerySweepStep = { name, ...stat };
      out[name].push(step);
      onStep?.(step);
    }
  }
  return out;
}
