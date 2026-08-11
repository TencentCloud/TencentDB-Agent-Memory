#!/usr/bin/env bun
// reindex-embeddings.ts — Crystal 021730
// Re-embed all L0 conversations and L1 records with the active embedding model
// (granite-embedding-311m, 768-dim) and write the new vectors into vec0 tables.
// Idempotent: if vec0 already has rows, they are replaced (reindexAll deletes+reinserts).
//
// Usage:
//   cd /home/penis/TencentDB-Agent-Memory
//   bun run scripts/reindex-embeddings.ts 2>&1 | tee /tmp/reindex.log
//
// Env:
//   EMBED_URL (default http://127.0.0.1:8421/embeddings)
//   DB_PATH   (default <root>/vectors.db)
//   LOG_EVERY (default 50)

import { loadGatewayConfig } from "../src/gateway/config.js";
import { resolveUnderRoot } from "../src/gateway/tdai-root.js";

const EMBED_URL = process.env.EMBED_URL ?? "http://127.0.0.1:8421/embeddings";
// The root MUST come from the same resolver the gateway runs on — yaml
// `data.baseDir` included. defaultTdaiRoot() ignores the yaml, so a
// yaml-rooted install would silently reindex an empty DB and exit 0.
const DB_PATH =
  process.env.DB_PATH ??
  resolveUnderRoot(loadGatewayConfig().data.baseDir, "vectors.db");
const LOG_EVERY = Number(process.env.LOG_EVERY ?? 50);

function log(msg: string): void {
  process.stderr.write(`[reindex] ${new Date().toISOString()} ${msg}\n`);
}

log(`DB: ${DB_PATH}`);
log(`EMBED_URL: ${EMBED_URL}`);
log(`LOG_EVERY: ${LOG_EVERY}`);

// Import the VectorStore (bun's TS loader resolves .js → .ts source)
const { VectorStore } = await import("../src/core/store/sqlite.js");

const store = new VectorStore(DB_PATH, 768);
const initResult = store.init({
  provider: "openai",
  model:
    "/home/penis/projects/granite-r2/granite-embedding-311m-multilingual-r2.Q8_0.gguf",
});
log(
  `init: needsReindex=${initResult.needsReindex} reason=${initResult.reason ?? "(none)"}`,
);
// VectorStoreInitResult has only {needsReindex, reason?}. We always reindex: the
// gateway's dim-change handler dropped vec0, so it's empty (or stale from a
// prior failed run). reindexAll is idempotent — it drops+repopulates.

async function embed(text: string): Promise<Float32Array> {
  const res = await fetch(EMBED_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  // Verified live: :8421/embeddings returns top-level LIST
  //   [{index:0, embedding:[[float768]]}]
  // i.e. d[0].embedding is a 1-element list; d[0].embedding[0] is the 768-dim vector.
  const d = (await res.json()) as Array<{
    index: number;
    embedding: number[][];
  }>;
  if (!Array.isArray(d) || !d[0]?.embedding?.[0]) {
    throw new Error(
      `unexpected response shape: ${JSON.stringify(d).slice(0, 200)}`,
    );
  }
  return new Float32Array(d[0].embedding[0]);
}

const t0 = Date.now();
let lastProgressLine = "";
const result = await store.reindexAll(embed, (done, total, layer) => {
  if (done % LOG_EVERY === 0 || done === total) {
    const pct = total > 0 ? ((done / total) * 100).toFixed(1) : "0";
    const elapsed = (Date.now() - t0) / 1000;
    const rate = elapsed > 0 ? (done / elapsed).toFixed(1) : "?";
    const line = `reindexed ${done}/${total} (${pct}%) [${layer}] rate=${rate}/s`;
    if (line !== lastProgressLine) {
      process.stderr.write(`${line}\n`);
      lastProgressLine = line;
    }
  }
});
const elapsed = (Date.now() - t0) / 1000;
// Use exact format expected by the verify grep (do not change)
process.stderr.write(
  `done: l1Count=${result.l1Count}, l0Count=${result.l0Count}, elapsed=${elapsed.toFixed(1)}s\n`,
);
log(`elapsed=${elapsed.toFixed(1)}s`);

store.close();
log("done");
