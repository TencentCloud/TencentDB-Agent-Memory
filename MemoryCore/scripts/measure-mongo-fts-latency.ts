/**
 * T1 measurement — Mongo change-stream → $search (mongot) visibility latency.
 *
 * Inserts N L1 rows one at a time and measures how long until each becomes
 * searchable via searchL1Fts (BM25). Throwaway diagnostic; not part of the
 * test suite. Run against atlas-local:
 *
 *   MONGODB_ENDPOINT="mongodb://127.0.0.1:27019/?directConnection=true" \
 *     node --import tsx scripts/measure-mongo-fts-latency.ts
 */
import { MongoClientPool } from "../src/core/store/mongodb/client-pool.js";
import { MongoMemoryStore } from "../src/core/store/mongodb/memory-store.js";
import { buildFtsQuery } from "../src/core/store/tokenize.js";
import type { MemoryRecord } from "../src/core/record/l1-writer.js";

const ENDPOINT = process.env.MONGODB_ENDPOINT;
if (!ENDPOINT) {
  console.error("MONGODB_ENDPOINT unset — aborting");
  process.exit(2);
}

const logger = { debug() {}, info() {}, warn() {}, error(m: string) { console.error(m); } };

async function main() {
  const pool = new MongoClientPool(logger);
  const database = `t1_latency_${Date.now()}`;
  const cfg = { endpoint: ENDPOINT!, user: "", password: "", database };
  const store = new MongoMemoryStore({ pool, mongoConfig: cfg, logger, searchIndexWaitMs: 90_000 });

  const t0 = Date.now();
  await store.init();
  console.log(`init (incl. search-index build): ${Date.now() - t0} ms`);

  const N = 8;
  const latencies: number[] = [];
  for (let i = 0; i < N; i++) {
    const id = `t1-${i}-${Math.random().toString(36).slice(2, 6)}`;
    const uniqueTok = `zqxlat${i}${Math.random().toString(36).slice(2, 6)}`;
    const rec: MemoryRecord = {
      id,
      content: `latency probe ${uniqueTok}`,
      type: "persona",
      priority: 50,
      scene_name: "",
      source_message_ids: [],
      metadata: {},
      timestamps: [new Date().toISOString()],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sessionKey: "sk",
      sessionId: "sid",
    };
    const q = buildFtsQuery(uniqueTok)!;
    const start = Date.now();
    await store.upsertL1(rec, undefined);
    // Poll until searchable.
    let visible = false;
    while (Date.now() - start < 30_000) {
      const hits = await store.searchL1Fts(q, 5);
      if (hits.some((h) => h.record_id === id)) { visible = true; break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    const dt = Date.now() - start;
    latencies.push(dt);
    console.log(`row ${i}: ${visible ? "visible" : "TIMEOUT"} in ${dt} ms`);
  }

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p90 = latencies[Math.floor(latencies.length * 0.9)];
  const max = latencies[latencies.length - 1];
  console.log(`\nwrite→searchable latency over ${N} rows: p50=${p50}ms p90=${p90}ms max=${max}ms`);

  const cleanup = await pool.getDb(cfg);
  await cleanup.dropDatabase();
  await pool.closeAll();
}

main().catch((e) => { console.error(e); process.exit(1); });
