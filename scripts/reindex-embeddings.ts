#!/usr/bin/env bun
// reindex-embeddings.ts — re-embed all L0 conversations and L1 records with the
// embedding model the GATEWAY is configured to use, and write the new vectors
// into the vec0 tables.
//
// Everything about the model — provider, base URL, model name, dimensions,
// whether it wants `dimensions` / `input_type` on the wire — comes from the
// gateway config, so this script cannot drift from the running gateway the way
// a second hardcoded copy of those values would. Idempotent: reindexAll
// deletes and reinserts every vector.
//
// Usage:
//   cd /home/penis/TencentDB-Agent-Memory
//   bun run scripts/reindex-embeddings.ts 2>&1 | tee /tmp/reindex.log
//
// Env:
//   DB_PATH   (default <gateway data root>/vectors.db)
//   LOG_EVERY (default 50)
//   TDAI_REINDEX_EMBED_BATCH (default 64) — texts per embedding call

import { loadGatewayConfig } from "../src/gateway/config.js";
import { resolveUnderRoot } from "../src/gateway/tdai-root.js";
import { createEmbeddingService } from "../src/core/store/embedding.js";

const gatewayConfig = loadGatewayConfig();
const embeddingConfig = gatewayConfig.memory.embedding;

// The root MUST come from the same resolver the gateway runs on — yaml
// `data.baseDir` included. defaultTdaiRoot() ignores the yaml, so a
// yaml-rooted install would silently reindex an empty DB and exit 0.
const DB_PATH =
  process.env.DB_PATH ??
  resolveUnderRoot(gatewayConfig.data.baseDir, "vectors.db");
const LOG_EVERY = Number(process.env.LOG_EVERY ?? 50);

function log(msg: string): void {
  process.stderr.write(`[reindex] ${new Date().toISOString()} ${msg}\n`);
}

if (!embeddingConfig.enabled || !embeddingConfig.apiKey) {
  log(
    `embedding is not configured in the gateway config (provider=${embeddingConfig.provider}) — nothing to reindex`,
  );
  process.exit(1);
}

log(`DB: ${DB_PATH}`);
log(
  `embedding: provider=${embeddingConfig.provider} model=${embeddingConfig.model} ` +
    `dims=${embeddingConfig.dimensions} baseUrl=${embeddingConfig.baseUrl}`,
);
log(`LOG_EVERY: ${LOG_EVERY}`);

const embeddingService = createEmbeddingService({
  provider: embeddingConfig.provider,
  baseUrl: embeddingConfig.baseUrl,
  apiKey: embeddingConfig.apiKey,
  model: embeddingConfig.model,
  dimensions: embeddingConfig.dimensions,
  sendDimensions: embeddingConfig.sendDimensions,
  sendInputType: embeddingConfig.sendInputType,
  maxInputChars: embeddingConfig.maxInputChars,
  timeoutMs: embeddingConfig.timeoutMs,
});

// Import the VectorStore (bun's TS loader resolves .js → .ts source)
const { VectorStore } = await import("../src/core/store/sqlite.js");

const store = new VectorStore(DB_PATH, embeddingConfig.dimensions);
const initResult = store.init({
  provider: embeddingConfig.provider,
  model: embeddingConfig.model,
});
log(
  `init: needsReindex=${initResult.needsReindex} reason=${initResult.reason ?? "(none)"}`,
);
// VectorStoreInitResult has only {needsReindex, reason?}. We always reindex: the
// gateway's dim-change handler dropped vec0, so it's empty (or stale from a
// prior failed run). reindexAll is idempotent — it drops+repopulates.

/** Everything reindexed is stored text, never a query — see EmbeddingCallOptions. */
const STORED = { inputType: "passage" } as const;

const t0 = Date.now();
let lastProgressLine = "";
const result = await store.reindexAll(
  (text) => embeddingService.embed(text, STORED),
  (done, total, layer) => {
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
  },
  (texts) => embeddingService.embedBatch(texts, STORED),
);
const elapsed = (Date.now() - t0) / 1000;
// Use exact format expected by the verify grep (do not change)
process.stderr.write(
  `done: l1Count=${result.l1Count}, l0Count=${result.l0Count}, elapsed=${elapsed.toFixed(1)}s\n`,
);
log(`elapsed=${elapsed.toFixed(1)}s`);

store.close();
log("done");
