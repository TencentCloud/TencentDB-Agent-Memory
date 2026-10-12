/**
 * L0 Mongo write/query bench — CLI entry.
 *
 * Two phases, two databases (so each reuses the exact production
 * `l0_conversations` collection + indexes + `$search`, and query numbers run
 * through the real `MongoMemoryStore` code paths):
 *
 *   Phase A (write-1m)  db `<base>_w1m`  — write N docs at batch=1/100/1000,
 *                       one tier at a time (drop between tiers). Dropped by
 *                       default; `--keep-1m` keeps the last tier.
 *   Phase B (write-100m) db `<base>_s100m` — write N docs at batch=1000, KEEP by
 *                       default (`--drop-100m` to remove), then run the query
 *                       benchmark against it.
 *
 * Examples:
 *   MONGODB_ENDPOINT="mongodb://127.0.0.1:27019/?directConnection=true" \
 *     node --import tsx scripts/bench-l0-mongo/bench.ts --mode smoke
 *
 *   node --import tsx scripts/bench-l0-mongo/bench.ts --mode all \
 *     --docs-1m 1000000 --docs-100m 100000000 --concurrency 8
 *
 *   node --import tsx scripts/bench-l0-mongo/bench.ts --mode query   # existing s100m
 */

import { MongoClientPool } from "../../src/core/store/mongodb/client-pool.js";
import { MongoMemoryStore } from "../../src/core/store/mongodb/memory-store.js";
import { COLLECTIONS } from "../../src/core/store/mongodb/collections.js";
import { buildFtsQuery } from "../../src/core/store/tokenize.js";
import type { MongoConfig } from "../../src/core/instance-config-provider.js";
import { defaultGenContext, makeDoc, queryTargetFor, type GenContext, type QueryTarget } from "./generate.js";
import { runInsert, type InsertResult, type ThroughputSample } from "./insert.js";
import { latencyStats } from "./metrics.js";
import { runQueries, waitForFtsVisibility } from "./query.js";
import { writeReport, type BenchReport } from "./report.js";

// Prefix every console line with a local timestamp — a 100M write runs for hours,
// so each [qps]/phase line needs a wall-clock anchor. Leading newlines are kept
// as separators; the stamp sits on the actual content line.
{
  const stamp = () => new Date().toLocaleString("sv-SE");
  const wrap =
    (orig: (...a: unknown[]) => void) =>
    (...args: unknown[]) => {
      const first = args[0];
      if (typeof first === "string") {
        const lead = first.match(/^\n*/)?.[0] ?? "";
        orig(`${lead}[${stamp()}] ${first.slice(lead.length)}`, ...args.slice(1));
      } else {
        orig(`[${stamp()}]`, ...args);
      }
    };
  console.log = wrap(console.log.bind(console));
  console.warn = wrap(console.warn.bind(console));
  console.error = wrap(console.error.bind(console));
}

type Mode = "smoke" | "write-1m" | "write-100m" | "query" | "all";

interface Args {
  uri: string;
  db: string;
  mode: Mode;
  concurrency: number;
  docs1m: number;
  /** Override doc count for the batch=1 tier only (it's RTT-bound and slow). */
  docs1mB1: number;
  docs100m: number;
  batch100m: number;
  batches1m: number[];
  poolSize: number;
  queryIters: number;
  /** Phase B canary seed size — verify $search before the full write. */
  canaryDocs: number;
  /** Max ms to wait for the canary index to become queryable. */
  canaryTimeoutMs: number;
  /**
   * Treat a failed canary as fatal (default). The whole point of Phase B is to
   * measure BM25 behaviour at scale, so writing 100M docs against a dead
   * `$search` index burns hours and yields meaningless query numbers. Pass
   * `--allow-unusable-fts` to continue anyway when you deliberately want a
   * write-only throughput run.
   */
  requireFts: boolean;
  /**
   * Write concern for the benchmarked inserts: `majority` (deployment default)
   * or `1` (primary-ack only).
   *
   * With `majority` on a 3-node set the primary must also wait for a secondary,
   * so when replication falls behind, flow control throttles the primary and
   * every in-flight batch blocks at once — the `inst=0/s` windows. `w:1` takes
   * the secondaries off the write path, which is the whole point of measuring
   * both: same data, same indexes, only the acknowledgement rule differs.
   */
  writeConcern: "majority" | "1";
  /** Throughput sampling interval (drives live QPS + the over-time chart). */
  sampleMs: number;
  keep1m: boolean;
  drop100m: boolean;
  skip1m: boolean;
  skip100m: boolean;
  /**
   * Phase B: continue an interrupted write instead of dropping + restarting.
   * Counts existing docs, skips the canary write, and only inserts the shortfall
   * up to `docs100m`. The `$search` index and data are reused as-is.
   */
  resume: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (name: string) => argv.includes(`--${name}`);
  const num = (name: string, def: number) => {
    const v = get(name);
    return v === undefined ? def : Number(v);
  };

  const mode = (get("mode") ?? "smoke") as Mode;
  const isSmoke = mode === "smoke";

  const uri =
    get("uri") ??
    process.env.MONGODB_ENDPOINT ??
    "mongodb://127.0.0.1:27019/?directConnection=true";

  const docs1m = num("docs-1m", isSmoke ? 1000 : 1_000_000);

  return {
    uri,
    db: get("db") ?? (isSmoke ? "l0_bench_smoke" : "l0_bench_local"),
    mode,
    concurrency: num("concurrency", 8),
    docs1m,
    docs1mB1: get("docs-1m-b1") !== undefined ? Number(get("docs-1m-b1")) : docs1m,
    docs100m: num("docs-100m", isSmoke ? 1000 : 100_000_000),
    batch100m: num("batch-100m", 1000),
    batches1m: (get("batches") ?? "1,100,1000").split(",").map((s) => Number(s.trim())).filter((n) => n > 0),
    poolSize: num("pool-size", isSmoke ? 500 : 10_000),
    queryIters: num("query-iters", isSmoke ? 50 : 200),
    canaryDocs: num("canary-docs", isSmoke ? 100 : 1000),
    canaryTimeoutMs: num("canary-timeout", 120_000),
    requireFts: !has("allow-unusable-fts"),
    writeConcern: get("write-concern") === "1" ? "1" : "majority",
    sampleMs: num("sample-ms", isSmoke ? 2_000 : 60_000),
    keep1m: has("keep-1m"),
    drop100m: has("drop-100m"),
    skip1m: has("skip-1m"),
    skip100m: has("skip-100m"),
    resume: has("resume"),
  };
}

const logger = {
  debug() {},
  info(m: string) { console.log(m); },
  warn(m: string) { console.warn(m); },
  error(m: string) { console.error(m); },
};

function hostOf(uri: string): string {
  try {
    return new URL(uri.replace(/^mongodb(\+srv)?:\/\//, "http://")).host;
  } catch {
    return uri;
  }
}

/** Compact human duration for live QPS/ETA lines (h / m / s). */
function fmtDur(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "?";
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`;
  if (seconds >= 60) return `${(seconds / 60).toFixed(1)}m`;
  return `${Math.round(seconds)}s`;
}

/**
 * Build an onSample handler that prints a live QPS line (own line, off the \r
 * progress bar). `writeDocs` is what THIS run inserts (drives ETA); `baseDocs` +
 * `grandTotal` render absolute progress toward the target (so a --resume run
 * shows `.../100,000,000`, not `.../shortfall`).
 */
function makeQpsLogger(
  label: string,
  writeDocs: number,
  baseDocs = 0,
  grandTotal = writeDocs,
): (s: ThroughputSample) => void {
  return (s: ThroughputSample) => {
    const left = Math.max(0, writeDocs - s.docs);
    const rate = s.intervalDocsPerSec > 0 ? s.intervalDocsPerSec : s.cumulativeDocsPerSec;
    const etaSec = rate > 0 ? left / rate : Infinity;
    const absDone = baseDocs + s.docs;
    const pct = grandTotal > 0 ? ((absDone / grandTotal) * 100).toFixed(0) : "?";
    console.log(
      `\n[qps] ${label} t=${fmtDur(s.tMs / 1000)} docs=${absDone.toLocaleString()}/${grandTotal.toLocaleString()} (${pct}%)` +
        ` inst=${Math.round(s.intervalDocsPerSec).toLocaleString()}/s avg=${Math.round(s.cumulativeDocsPerSec).toLocaleString()}/s eta=${fmtDur(etaSec)}`,
    );
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pool = new MongoClientPool(logger as never);

  const cfgFor = (database: string): MongoConfig => ({ endpoint: args.uri, user: "", password: "", database });
  const w1mDb = `${args.db}_w1m`;
  const scaleDb = `${args.db}_s100m`;

  const runWrite1m = (args.mode === "write-1m" || args.mode === "all" || args.mode === "smoke") && !args.skip1m;
  const runWrite100m = (args.mode === "write-100m" || args.mode === "all" || args.mode === "smoke") && !args.skip100m;
  const runQuery = args.mode === "query" || args.mode === "write-100m" || args.mode === "all" || args.mode === "smoke";

  const startedAt = new Date().toISOString();
  const report: BenchReport = {
    schema: "l0-mongo-bench/v2",
    mode: args.mode,
    startedAt,
    finishedAt: startedAt,
    uriHost: hostOf(args.uri),
    concurrency: args.concurrency,
    writeConcern: args.writeConcern,
  };

  console.log(
    `\n=== L0 Mongo bench — mode=${args.mode} host=${report.uriHost}` +
      ` concurrency=${args.concurrency} writeConcern=w:${args.writeConcern} ===`,
  );

  try {
    // ── Phase A: write-1m, scan batch tiers ────────────────────────────────
    if (runWrite1m) {
      const b1note = args.docs1mB1 !== args.docs1m ? ` (batch=1 tier: ${args.docs1mB1})` : "";
      console.log(`\n[Phase A] write ${args.docs1m} docs per tier ${JSON.stringify(args.batches1m)}${b1note} → db=${w1mDb}`);
      const byBatch: Record<string, InsertResult> = {};
      // Context sized to the largest tier so the template/session pools cover it.
      const ctx = defaultGenContext(args.poolSize, Math.max(args.docs1m, args.docs1mB1));

      // Build the production-shaped indexes (btree + `$search`) ONCE. Between
      // tiers we clear docs with deleteMany instead of dropping the database, so
      // mongot never tears down / rebuilds the Lucene index mid-run (that churn
      // makes atlas-local fall minutes behind). `$search` readiness is irrelevant
      // for a write-only phase, so we don't block long on it.
      await dropDatabase(pool, cfgFor(w1mDb));
      const store = new MongoMemoryStore({ pool, mongoConfig: cfgFor(w1mDb), logger, searchIndexWaitMs: 5_000 });
      await store.init();
      const coll = (await pool.getDb(cfgFor(w1mDb))).collection(COLLECTIONS.L0, collOpts(args));

      for (const batch of args.batches1m) {
        await coll.deleteMany({}); // isolate tiers without index teardown
        // batch=1 is pure RTT-bound and slow; allow a smaller sample for it.
        const tierDocs = batch === 1 ? args.docs1mB1 : args.docs1m;
        console.log(`  · batch=${batch} (${tierDocs} docs) …`);
        const res = await runInsert({
          coll,
          totalDocs: tierDocs,
          batch,
          concurrency: args.concurrency,
          gen: (gi) => makeDoc(gi, ctx),
          onProgress: (d, t) => process.stdout.write(`\r    ${d}/${t} (${((d / t) * 100).toFixed(0)}%)   `),
          sampleEveryMs: args.sampleMs,
          onSample: makeQpsLogger(`A batch=${batch}`, tierDocs),
        });
        process.stdout.write("\n");
        console.log(`    docs/s=${res.docsPerSec} p50=${res.batchLatency.p50Ms}ms p99=${res.batchLatency.p99Ms}ms errors=${res.errors}`);
        byBatch[String(batch)] = res;
      }
      store.close();

      const dropped = !args.keep1m;
      if (dropped) {
        await dropDatabase(pool, cfgFor(w1mDb));
        console.log(`  dropped ${w1mDb}`);
      } else {
        console.log(`  kept ${w1mDb} (last tier data)`);
      }
      report.write1m = { dbName: w1mDb, docsPerTier: args.docs1m, dropped, byBatch };
    }

    // ── Phase B: write-100m + query ────────────────────────────────────────
    let scaleStore: MongoMemoryStore | null = null;

    if (runWrite100m) {
      const resuming = args.resume;
      console.log(
        `\n[Phase B] ${resuming ? "RESUME → target" : "write"} ${args.docs100m} docs batch=${args.batch100m} → db=${scaleDb}`,
      );
      // Fresh run drops + rebuilds; --resume keeps existing data + index and only
      // fills the shortfall (survives an interrupted multi-hour write).
      if (!resuming) {
        await dropDatabase(pool, cfgFor(scaleDb));
      }
      // The canary (fresh) / read-only probe (resume) is the real FTS gate, so
      // don't block long on queryability at init.
      scaleStore = new MongoMemoryStore({ pool, mongoConfig: cfgFor(scaleDb), logger, searchIndexWaitMs: 10_000 });
      // Index creation happens inside init(); time from here to `queryable` is the
      // real "how long did mongot take to build the index" number (fresh run only).
      const tInitStart = performance.now();
      await scaleStore.init();
      const coll = (await pool.getDb(cfgFor(scaleDb))).collection(COLLECTIONS.L0, collOpts(args));

      const ctx = defaultGenContext(args.poolSize, args.docs100m);
      const target = queryTargetFor(ctx);

      // Canary / resume-probe results (report fields), filled by whichever branch runs.
      let canaryDocs = 0;
      let canaryVisMs = -1;
      let canaryHits = 0;
      let ftsUsable = false;
      let indexReadyPollMs = 0;
      let indexReadySinceInitMs = 0;
      let alreadyWritten = 0; // globalIndex offset the sustained write starts from

      if (!resuming) {
        // ── Canary: seed a small batch and PROVE $search works before committing
        //    to the (possibly multi-hour) full write. The first `canaryDocs`
        //    globalIndexes deterministically include the query target (session 0,
        //    team-0, pool[0] text), so a hit is expected when the index is healthy.
        canaryDocs = Math.max(1, Math.min(args.canaryDocs, Math.floor(args.docs100m / 2) || args.docs100m));
        console.log(`  · canary: writing ${canaryDocs} docs, then verifying $search is usable …`);
        await runInsert({
          coll,
          totalDocs: canaryDocs,
          batch: args.batch100m,
          concurrency: args.concurrency,
          gen: (gi) => makeDoc(gi, ctx),
        });
        // Re-evaluate readiness now that docs exist (init ran on an empty coll).
        const tReadyStart = performance.now();
        const ready = await scaleStore.refreshSearchIndexReady(args.canaryTimeoutMs);
        indexReadyPollMs = Math.round(performance.now() - tReadyStart);
        indexReadySinceInitMs = Math.round(performance.now() - tInitStart);
        console.log(
          `  · [canary] $search queryable=${ready} — took ${indexReadyPollMs}ms of post-data polling` +
            ` (${indexReadySinceInitMs}ms since index creation).`,
        );
        canaryVisMs = await waitForFtsVisibility(scaleStore, target, args.canaryTimeoutMs);
        const probe = await countFtsHits(scaleStore, target);
        canaryHits = probe.hits;
        ftsUsable = canaryVisMs >= 0 && canaryHits > 0;
        if (ftsUsable) {
          console.log(`  · [canary] OK — $search returned ${canaryHits} hits after ${canaryVisMs}ms on ${canaryDocs} docs; proceeding.`);
        } else {
          failCanary(args, scaleStore, scaleDb, {
            docs: canaryDocs,
            ftsVisibilityMs: canaryVisMs,
            hits: canaryHits,
            usable: false,
            indexReadyPollMs,
            indexReadySinceInitMs,
            error: probe.error,
          });
        }
        alreadyWritten = canaryDocs;
      } else {
        // ── Resume: data + index already exist. Don't drop, don't canary-write.
        //    Count what's there and verify $search read-only before continuing.
        const existing = await coll.estimatedDocumentCount();
        alreadyWritten = existing;
        console.log(`  · resume: ${existing.toLocaleString()} docs already present; verifying $search (read-only) …`);
        const ready = await scaleStore.refreshSearchIndexReady(args.canaryTimeoutMs);
        canaryVisMs = await waitForFtsVisibility(scaleStore, target, args.canaryTimeoutMs);
        const probe = await countFtsHits(scaleStore, target);
        canaryHits = probe.hits;
        ftsUsable = canaryVisMs >= 0 && canaryHits > 0;
        console.log(
          `  · [resume] existing=${existing.toLocaleString()} $search ready=${ready} hits=${canaryHits} (${ftsUsable ? "usable" : "UNUSABLE"}).`,
        );
        if (!ftsUsable) {
          failCanary(args, scaleStore, scaleDb, {
            docs: 0,
            ftsVisibilityMs: canaryVisMs,
            hits: canaryHits,
            usable: false,
            indexReadyPollMs,
            indexReadySinceInitMs,
            error: probe.error,
          });
        }
      }

      // ── Sustained write: fill the shortfall up to docs100m. Carries the QPS
      //    time series (live [qps] lines + the over-time chart). ──────────────
      const remaining = Math.max(0, args.docs100m - alreadyWritten);
      let insert: InsertResult;
      if (remaining > 0) {
        console.log(
          `  · writing remaining ${remaining.toLocaleString()} docs (offset ${alreadyWritten.toLocaleString()})` +
            ` batch=${args.batch100m} (sampling every ${args.sampleMs}ms) …`,
        );
        insert = await runInsert({
          coll,
          totalDocs: remaining,
          batch: args.batch100m,
          concurrency: args.concurrency,
          gen: (gi) => makeDoc(gi + alreadyWritten, ctx),
          onProgress: (d, t) => process.stdout.write(`\r    ${d}/${t} (${((d / t) * 100).toFixed(0)}%)   `),
          sampleEveryMs: args.sampleMs,
          onSample: makeQpsLogger("B", remaining, alreadyWritten, args.docs100m),
        });
        process.stdout.write("\n");
      } else {
        console.log(`  · already at/above target (${alreadyWritten.toLocaleString()} ≥ ${args.docs100m.toLocaleString()}); nothing to write.`);
        insert = {
          docs: 0, batch: args.batch100m, concurrency: args.concurrency,
          wallMs: 0, docsPerSec: 0, batchesPerSec: 0, errors: 0,
          batchLatency: latencyStats([]), samples: [],
          stalls: {
            slowBatchThresholdMs: 0, slowBatches: 0, slowBatchPct: 0,
            longestBatchMs: 0, zeroWindows: 0, degradedWindows: 0, zeroWindowAtMs: [],
          },
        };
      }
      {
        const L = insert.batchLatency, S = insert.stalls;
        console.log(`    docs/s=${insert.docsPerSec} errors=${insert.errors}`);
        console.log(
          `    批延迟 p50=${L.p50Ms}ms p90=${L.p90Ms}ms p95=${L.p95Ms}ms` +
            ` p99=${L.p99Ms}ms p999=${L.p999Ms}ms max=${L.maxMs}ms`,
        );
        console.log(
          `    [stall] w:${args.writeConcern} — 零吞吐窗口=${S.zeroWindows} 降级窗口=${S.degradedWindows}` +
            ` 慢批次=${S.slowBatches}/${L.count} (${S.slowBatchPct}%, 阈值 ${S.slowBatchThresholdMs}ms)` +
            ` 最长单批=${(S.longestBatchMs / 1000).toFixed(1)}s`,
        );
        if (S.zeroWindows > 0) {
          console.log(`    [stall] 零吞吐窗口出现在 t = ${S.zeroWindowAtMs.map((m) => (m / 60000).toFixed(0) + "m").join(", ")}`);
        }
      }

      // Re-confirm visibility after the full corpus landed.
      console.log(`  waiting for $search (mongot) visibility …`);
      const ftsVisibilityMs = await waitForFtsVisibility(scaleStore, target);
      console.log(`    fts visible after ${ftsVisibilityMs}ms`);

      const kept = !args.drop100m;
      report.write100m = {
        dbName: scaleDb,
        docs: args.docs100m,
        batch: args.batch100m,
        kept,
        insert,
        ftsVisibilityMs,
        canary: {
          docs: canaryDocs,
          ftsVisibilityMs: canaryVisMs,
          hits: canaryHits,
          usable: ftsUsable,
          indexReadyPollMs,
          indexReadySinceInitMs,
        },
        ftsUsable,
      };
    }

    if (runQuery) {
      if (!scaleStore) {
        scaleStore = new MongoMemoryStore({ pool, mongoConfig: cfgFor(scaleDb), logger, searchIndexWaitMs: 180_000 });
        await scaleStore.init();
      }
      // Rebuild the same deterministic target (context sizing is docs-driven).
      const ctx: GenContext = defaultGenContext(args.poolSize, args.docs100m);
      const target = queryTargetFor(ctx);
      console.log(`\n[Query] ${args.queryIters} iters/type against db=${scaleDb}`);
      if (report.write100m && report.write100m.ftsUsable === false) {
        console.log(`  [query] FTS unavailable — searchL0Fts numbers below are NOT meaningful (index never became usable).`);
      }
      report.query = await runQueries(scaleStore, target, args.queryIters);
      for (const [name, stat] of Object.entries(report.query)) {
        console.log(`  ${name.padEnd(18)} qps=${String(stat.qps).padStart(8)}  p50=${stat.latency.p50Ms}ms p99=${stat.latency.p99Ms}ms hits=${stat.lastHits}`);
      }
    }

    if (scaleStore) scaleStore.close();

    // Persist the report BEFORE any optional cleanup, so a transient remote
    // error (e.g. a replica-set failover surfacing on the drop) can never lose
    // a run's results — especially a multi-hour one.
    report.finishedAt = new Date().toISOString();
    const path = writeReport(report);
    console.log(`\n✓ report → ${path}`);
    console.log(`  open scripts/bench-l0-mongo/view-report.html and load that file.`);

    if (report.write100m && args.drop100m) {
      try {
        await dropDatabase(pool, cfgFor(scaleDb));
        console.log(`  dropped ${scaleDb}`);
      } catch (e) {
        console.warn(`  [cleanup] failed to drop ${scaleDb} (report already saved): ${(e as Error).message}`);
      }
    } else if (report.write100m) {
      console.log(`  kept ${scaleDb}`);
    }
  } finally {
    await pool.closeAll();
  }
}

async function dropDatabase(pool: MongoClientPool, cfg: MongoConfig): Promise<void> {
  const db = await pool.getDb(cfg);
  await db.dropDatabase();
}

/**
 * Collection options carrying the benchmarked write concern.
 *
 * Applied at the collection handle rather than the connection URI so it covers
 * exactly the inserts we measure and shows up verbatim in the report, instead
 * of hiding in a connection string the reader never sees.
 */
function collOpts(args: Args): { writeConcern: { w: "majority" | 1 } } {
  return { writeConcern: { w: args.writeConcern === "1" ? 1 : "majority" } };
}

/**
 * Raised when the canary proves `$search` unusable. Thrown (rather than
 * `process.exit`) so `main`'s `finally` still closes the pool.
 */
class CanaryGateFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanaryGateFailure";
  }
}

type CanaryResult = {
  docs: number;
  ftsVisibilityMs: number;
  hits: number;
  usable: boolean;
  indexReadyPollMs: number;
  indexReadySinceInitMs: number;
  /** mongot's own rejection message, when it refused the query outright. */
  error?: string;
};

/**
 * Best-effort BM25 hit count for the canary target.
 *
 * mongot may reject the query rather than return zero rows — e.g.
 * `cannot query search index … while in state NOT_STARTED`, which means
 * `listSearchIndexes` advertised the index as queryable while the data plane
 * had not begun building it. That is a canary failure, not a bench crash, so
 * swallow the throw but keep the message: it is the single most useful line to
 * hand to whoever operates mongot.
 */
async function countFtsHits(
  store: MongoMemoryStore,
  target: QueryTarget,
): Promise<{ hits: number; error?: string }> {
  const q = buildFtsQuery(target.hitText);
  if (!q) return { hits: 0, error: "canary text tokenized to an empty query" };
  try {
    const rows = await store.searchL0Fts(q, 5, {
      teamId: target.teamId,
      userId: target.userId,
      agentId: target.agentId,
    });
    return { hits: rows.length };
  } catch (e) {
    return { hits: 0, error: (e as Error).message };
  }
}

/**
 * Handle an unusable-`$search` canary: abort by default, or warn and continue
 * under `--allow-unusable-fts`.
 *
 * Aborting is the right default because Phase B exists to measure BM25 at
 * scale — continuing spends hours writing 100M docs only to report `hits=0`
 * for every `$search` query, which is indistinguishable from a real regression
 * when someone reads the JSON later.
 */
function failCanary(
  args: Args,
  store: MongoMemoryStore,
  scaleDb: string,
  canary: CanaryResult,
): void {
  const detail =
    `$search returned ${canary.hits} hits within ${args.canaryTimeoutMs}ms` +
    ` (searchIndexReady=${store.getCapabilities().ftsSearch},` +
    ` index queryable after ${canary.indexReadySinceInitMs}ms)` +
    (canary.error ? `; mongot said: ${canary.error}` : "");

  if (!args.requireFts) {
    console.log(
      `\n  · [canary] INDEX UNUSABLE — ${detail}.` +
        ` --allow-unusable-fts set, continuing with FTS marked UNAVAILABLE.\n`,
    );
    return;
  }

  console.error(`\n  · [canary] INDEX UNUSABLE — ${detail}.`);
  console.error(`  · Refusing to write ${args.docs100m.toLocaleString()} docs against a dead $search index.`);
  console.error(`  · Inspect the index, then re-run:`);
  console.error(
    `      mongosh "$MONGODB_ENDPOINT" --quiet --eval '` +
      `db.getSiblingDB("${scaleDb}").l0_conversations.aggregate([{$listSearchIndexes:{}}]).toArray()'`,
  );
  console.error(`  · To benchmark writes anyway (BM25 numbers will be meaningless), pass --allow-unusable-fts.\n`);
  throw new CanaryGateFailure(detail);
}

main().catch((err) => {
  if (err instanceof CanaryGateFailure) {
    console.error(`[bench] aborted at canary gate: ${err.message}`);
    process.exit(2);
  }
  console.error("\n[bench] fatal:", err);
  process.exit(1);
});
