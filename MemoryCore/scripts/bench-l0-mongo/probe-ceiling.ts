/**
 * QPS ceiling probe — find the max sustainable write throughput and separate the
 * region (RTT) component from the server-side write cost.
 *
 * Why this exists: a *single serial* write is RTT-bound (≈ ping) — at ~40ms
 * round-trip the ceiling is ~25/s no matter how fast the server is. But
 * *aggregate* QPS is NOT RTT-bound: with enough in-flight writes the server (not
 * the round-trip) becomes the limit. This probe measures both halves:
 *
 *   1) [serial]  concurrency=1 batch=1 → single-write latency floor. Given the
 *      measured RTT (--rtt-ms, from ping), server_time ≈ p50 − RTT and the
 *      region-free single-write ceiling ≈ 1000 / server_time. This is the answer
 *      to "how fast is one write if we take the geography out".
 *   2) [sweep]   fixed batch, concurrency ∈ --concurrencies → the docs/s curve.
 *      Where it plateaus is the server write ceiling, which is largely
 *      region-independent (concurrency hides the fixed per-op RTT).
 *
 * NOTE: to actually reach high concurrency, put `maxPoolSize=<N>` in the URI
 * (the driver default is 100); otherwise workers queue on the connection pool.
 *
 * Index gate: the probe drops the DB, submits the `$search` index, then POLLS
 * until it is queryable — logging each BUILDING→READY poll and the total
 * "create → queryable" time — before running the sweep. It refuses to run on a
 * not-ready index (`--index-timeout <ms>`, `--skip-index-gate` to override).
 *
 * Usage:
 *   MONGODB_ENDPOINT="mongodb://.../?...&maxPoolSize=300" \
 *     node --import tsx scripts/bench-l0-mongo/probe-ceiling.ts \
 *       --rtt-ms 40 --batch 1 --docs-per-step 6000 --concurrencies 1,4,8,16,32,64,128,256
 */

import type { Collection } from "mongodb";
import { MongoClientPool } from "../../src/core/store/mongodb/client-pool.js";
import { MongoMemoryStore } from "../../src/core/store/mongodb/memory-store.js";
import { COLLECTIONS } from "../../src/core/store/mongodb/collections.js";
import { MEMORY_SEARCH_INDEX } from "../../src/core/store/mongodb/search-index.js";
import type { MongoConfig } from "../../src/core/instance-config-provider.js";
import { defaultGenContext, makeDoc } from "./generate.js";
import { runInsert, type InsertResult } from "./insert.js";

/**
 * Poll `$search` (mongot) until the named index reports queryable, logging every
 * poll so the BUILDING → READY transition is visible. Returns elapsed ms from
 * `sinceMs` (the index-submit instant, ≈ store.init start), or -1 on timeout.
 */
async function waitForSearchReady(
  coll: Collection,
  name: string,
  sinceMs: number,
  timeoutMs: number,
  pollMs = 2_000,
): Promise<number> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    let status = "?";
    let queryable = false;
    try {
      const rows = (await coll.listSearchIndexes(name).toArray()) as Array<{
        name: string;
        status?: string;
        queryable?: boolean;
      }>;
      const idx = rows.find((r) => r.name === name) ?? rows[0];
      status = idx?.status ?? "MISSING";
      queryable = !!idx?.queryable;
    } catch (e) {
      status = "ERR:" + (e as Error).message;
    }
    const elapsed = performance.now() - sinceMs;
    console.log(`  [index] t=${(elapsed / 1000).toFixed(1)}s status=${status} queryable=${queryable}`);
    if (queryable) return Math.round(elapsed);
    if (performance.now() > deadline) return -1;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

const logger = {
  debug: () => {},
  info: (m: string) => console.log(m),
  warn: (m: string) => console.log(m),
  error: (m: string) => console.log(m),
} as never;

function arg(name: string, def: string): string {
  const p = process.argv.slice(2);
  const i = p.indexOf(`--${name}`);
  return i >= 0 && p[i + 1] ? p[i + 1] : def;
}

function hostOf(uri: string): string {
  try {
    const m = uri.match(/@([^/?]+)/);
    return m ? m[1] : uri.slice(0, 40);
  } catch {
    return uri.slice(0, 40);
  }
}

async function main() {
  const uri = process.env.MONGODB_ENDPOINT || arg("uri", "");
  if (!uri) {
    console.error("set MONGODB_ENDPOINT or --uri");
    process.exit(1);
  }
  const rttMs = Number(arg("rtt-ms", "40"));
  const batch = Number(arg("batch", "1"));
  const docsPerStep = Number(arg("docs-per-step", "6000"));
  const serialDocs = Number(arg("serial-docs", "400"));
  const concurrencies = arg("concurrencies", "1,4,8,16,32,64,128,256")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => n > 0);
  const dbName = arg("db", "l0_bench_ceiling");
  const keep = process.argv.includes("--keep");
  const indexTimeoutMs = Number(arg("index-timeout", "180000"));
  const skipIndexGate = process.argv.includes("--skip-index-gate");

  const pool = new MongoClientPool(logger);
  const cfg: MongoConfig = { endpoint: uri, user: "", password: "", database: dbName };

  // Fresh DB so the `$search` index is built from scratch — that is what lets us
  // time "create → queryable" honestly (a leftover index would already be ready).
  await (await pool.getDb(cfg)).dropDatabase().catch(() => {});

  // Short init wait: init only SUBMITS the index; we do our own timed poll below.
  const store = new MongoMemoryStore({ pool, mongoConfig: cfg, logger, searchIndexWaitMs: 1_000 });
  const tCreate = performance.now();
  await store.init();
  const coll = (await pool.getDb(cfg)).collection(COLLECTIONS.L0);

  // ── Wait for $search to actually become queryable, timed from submission ─────
  console.log(`\n[index] waiting for "${MEMORY_SEARCH_INDEX}" to become queryable (empty collection) …`);
  const readyMs = await waitForSearchReady(coll, MEMORY_SEARCH_INDEX, tCreate, indexTimeoutMs);
  if (readyMs < 0) {
    console.log(`\n[index] ✗ NOT queryable within ${(indexTimeoutMs / 1000).toFixed(0)}s.`);
    if (!skipIndexGate) {
      console.log(`[index] refusing to run the ceiling sweep on a not-ready index (pass --skip-index-gate to override).`);
      store.close();
      await pool.closeAll();
      process.exit(1);
    }
    console.log(`[index] --skip-index-gate set — running write ceiling anyway ($search is not needed for writes).`);
  } else {
    console.log(`\n[index] ✓ create → queryable took ${(readyMs / 1000).toFixed(1)}s.`);
  }

  // Context sized to the largest per-step index we will pass to makeDoc.
  const ctx = defaultGenContext(2_000, Math.max(docsPerStep, serialDocs));

  console.log(
    `\n=== QPS ceiling probe — host=${hostOf(uri)} rtt=${rttMs}ms batch=${batch} docs/step=${docsPerStep} ===`,
  );
  const maxPool = uri.match(/maxPoolSize=(\d+)/);
  console.log(`  maxPoolSize=${maxPool ? maxPool[1] : "100 (driver default — >100 concurrency will queue!)"}`);

  // ── 1) serial single-write latency floor ────────────────────────────────────
  console.log(`\n[serial] concurrency=1 batch=1 (${serialDocs} docs) — single-write floor`);
  const serial = await runInsert({
    coll,
    totalDocs: serialDocs,
    batch: 1,
    concurrency: 1,
    gen: (i) => makeDoc(i, ctx),
  });
  const serverMs = Math.max(0.1, serial.batchLatency.p50Ms - rttMs);
  console.log(
    `  write latency p50=${serial.batchLatency.p50Ms}ms p90=${serial.batchLatency.p90Ms}ms p99=${serial.batchLatency.p99Ms}ms → serial docs/s=${serial.docsPerSec}`,
  );
  console.log(
    `  → RTT=${rttMs}ms; server_time ≈ p50−RTT = ${serverMs.toFixed(1)}ms → region-free single-write ceiling ≈ ${Math.round(1000 / serverMs)}/s`,
  );

  // ── 2) concurrency sweep at fixed batch ─────────────────────────────────────
  console.log(`\n[sweep] batch=${batch}, ${docsPerStep} docs/step`);
  console.log(`  conc |    docs/s |   p50 |    p99 | errors`);
  console.log(`  -----+-----------+-------+--------+-------`);
  const rows: Array<{ c: number } & InsertResult> = [];
  for (const c of concurrencies) {
    const r = await runInsert({
      coll,
      totalDocs: docsPerStep,
      batch,
      concurrency: c,
      gen: (i) => makeDoc(i, ctx),
    });
    rows.push({ c, ...r });
    console.log(
      `  ${String(c).padStart(4)} | ${String(r.docsPerSec).padStart(9)} | ${String(r.batchLatency.p50Ms).padStart(5)} | ${String(r.batchLatency.p99Ms).padStart(6)} | ${r.errors}`,
    );
  }
  const best = rows.reduce((a, b) => (b.docsPerSec > a.docsPerSec ? b : a));
  console.log(
    `\n  peak docs/s = ${best.docsPerSec} at concurrency=${best.c} (batch=${batch}).` +
      ` Region adds a fixed ~${rttMs}ms latency per op but does NOT cap this aggregate ceiling.`,
  );

  store.close();
  if (!keep) {
    await (await pool.getDb(cfg)).dropDatabase().catch(() => {});
    console.log(`  dropped ${dbName}`);
  } else {
    console.log(`  kept ${dbName}`);
  }
  await pool.closeAll();
}

main().catch((e) => {
  console.error("[probe] fatal:", e);
  process.exit(1);
});
