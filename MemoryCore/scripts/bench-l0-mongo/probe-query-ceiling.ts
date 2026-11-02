/**
 * Read-side QPS ceiling probe — the query counterpart to `probe-ceiling.ts`.
 *
 * A serial read benchmark reports `qps = 1000 / latency`, which across a
 * cross-region link is almost entirely the fixed RTT (~39ms here → ~25 qps) and
 * says nothing about what the server can serve. Running many requests in flight
 * amortizes that RTT away, so aggregate QPS climbs roughly linearly with
 * concurrency until the *server* saturates — that plateau is the real ceiling,
 * and it is largely region-independent.
 *
 * Runs read-only against an existing collection (no writes, no drops), driving
 * the same production `MongoMemoryStore` methods the gateway uses.
 *
 * NOTE: put `maxPoolSize=<N>` in the URI (driver default is 100) or workers will
 * queue on the connection pool instead of reaching the server.
 *
 * Usage:
 *   MONGODB_ENDPOINT="mongodb://.../?...&maxPoolSize=300" \
 *     node --import tsx scripts/bench-l0-mongo/probe-query-ceiling.ts \
 *       --db l0_bench_prod2 --docs-100m 100000000 --pool-size 100 \
 *       --rtt-ms 39 --iters 300 --concurrencies 1,4,8,16,32,64,128
 */

import { MongoClientPool } from "../../src/core/store/mongodb/client-pool.js";
import { MongoMemoryStore } from "../../src/core/store/mongodb/memory-store.js";
import type { MongoConfig } from "../../src/core/instance-config-provider.js";
import { defaultGenContext, queryTargetFor } from "./generate.js";
import { runQuerySweep, type QuerySweepStep } from "./query.js";
import { writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS = join(__dirname, "reports");

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

async function main() {
  const uri = process.env.MONGODB_ENDPOINT || arg("uri", "");
  if (!uri) {
    console.error("set MONGODB_ENDPOINT or --uri");
    process.exit(1);
  }
  const dbBase = arg("db", "l0_bench_prod2");
  const dbName = `${dbBase}_s100m`;
  const docs100m = Number(arg("docs-100m", "100000000"));
  const poolSize = Number(arg("pool-size", "100"));
  const rttMs = Number(arg("rtt-ms", "39"));
  const iters = Number(arg("iters", "300"));
  const concurrencies = arg("concurrencies", "1,4,8,16,32,64,128")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => n > 0);
  // Restrict to specific query names, e.g. to push only the ones still scaling.
  const only = arg("only", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const pool = new MongoClientPool(logger);
  const cfg: MongoConfig = { endpoint: uri, user: "", password: "", database: dbName };
  const store = new MongoMemoryStore({ pool, mongoConfig: cfg, logger, searchIndexWaitMs: 30_000 });
  await store.init();

  // Same deterministic target the write phase seeded (session 0 / team-0 / pool[0]).
  const ctx = defaultGenContext(poolSize, docs100m);
  const target = queryTargetFor(ctx);

  const maxPool = uri.match(/maxPoolSize=(\d+)/);
  console.log(`\n=== Query QPS ceiling — db=${dbName} rtt=${rttMs}ms iters/step=${iters} ===`);
  console.log(`  maxPoolSize=${maxPool ? maxPool[1] : "100 (driver default — >100 concurrency will queue!)"}`);
  console.log(`  concurrencies=${concurrencies.join(",")}`);

  let current = "";
  const sweep = await runQuerySweep(
    store,
    target,
    iters,
    concurrencies,
    (s: QuerySweepStep) => {
      if (s.name !== current) {
        current = s.name;
        console.log(`\n[${s.name}]`);
        console.log(`  conc |     qps |   p50 |    p99 | hits | err`);
        console.log(`  -----+---------+-------+--------+------+----`);
      }
      console.log(
        `  ${String(s.concurrency).padStart(4)} | ${String(s.qps).padStart(7)} |` +
          ` ${String(s.latency.p50Ms).padStart(5)} | ${String(s.latency.p99Ms).padStart(6)} |` +
          ` ${String(s.lastHits).padStart(4)} | ${s.errors}`,
      );
    },
    only,
  );

  console.log(`\n=== Peak QPS per query type ===`);
  const peaks: Record<string, QuerySweepStep> = {};
  for (const [name, steps] of Object.entries(sweep)) {
    const best = steps.reduce((a, b) => (b.qps > a.qps ? b : a));
    peaks[name] = best;
    const serial = steps.find((s) => s.concurrency === 1);
    const gain = serial ? (best.qps / serial.qps).toFixed(1) : "?";
    console.log(
      `  ${name.padEnd(18)} peak=${String(best.qps).padStart(8)}/s @conc=${String(best.concurrency).padStart(4)}` +
        ` (serial ${serial ? serial.qps : "?"}/s → ${gain}× by hiding RTT)  p99=${best.latency.p99Ms}ms`,
    );
  }

  const outName = `l0-query-ceiling-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const payload = {
    schema: "l0-query-ceiling/v1",
    generatedAt: new Date().toISOString(),
    dbName,
    rttMs,
    itersPerStep: iters,
    concurrencies,
    sweep,
    peaks,
  };
  writeFileSync(join(REPORTS, outName), JSON.stringify(payload, null, 2));
  const idxPath = join(REPORTS, "index.json");
  let idx: string[] = [];
  try {
    idx = JSON.parse(readFileSync(idxPath, "utf8"));
  } catch {
    idx = [];
  }
  writeFileSync(idxPath, JSON.stringify([outName, ...idx.filter((n) => n !== outName)], null, 2));
  console.log(`\n✓ report → reports/${outName}`);

  store.close();
  await pool.closeAll();
}

main().catch((e) => {
  console.error("[query-probe] fatal:", e);
  process.exit(1);
});
