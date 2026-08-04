/**
 * Multi-strategy memory search dispatcher. Per-strategy implementations
 * live in `./search-keyword.ts`, `./search-embedding.ts`, `./search-hybrid.ts`.
 *
 * Strategy resolution:
 *   - "keyword"   → FTS5 BM25 (or skip if FTS5 unavailable)
 *   - "embedding" → VectorStore cosine similarity
 *   - "hybrid"    → short-circuit to native hybrid if supported, else RRF
 *
 * All three paths apply `passesScope` and the per-type rerank weights.
 */

import { sanitizeText } from "../../../utils/sanitize.js";
import type { MemoryTdaiConfig } from "../../../config.js";
import type { EmbeddingCallOptions, EmbeddingService } from "../../store/embedding.js";
import type { IMemoryStore } from "../../store/types.js";
import type { Logger } from "../../types.js";
import { TAG, type RecallStrategy, type SearchResult, type TypeWeights } from "./types.js";
import { searchByKeyword } from "./search-keyword.js";
import { searchByEmbedding } from "./search-embedding.js";
import { searchHybrid } from "./search-hybrid.js";
import { passesScope } from "./scope.js";
import type { ScopeDecayConfig } from "./scope-decay.js";

const emptyResult: SearchResult = { lines: [], timing: { ftsMs: 0, embeddingMs: 0, ftsHits: 0, embeddingHits: 0 } };

export async function searchMemories(
  userText: string,
  pluginDataDir: string,
  cfg: MemoryTdaiConfig,
  logger: Logger | undefined,
  strategy: RecallStrategy,
  vectorStore?: IMemoryStore,
  embeddingService?: EmbeddingService,
  projectId = "",
): Promise<SearchResult> {
  const cleanText = sanitizeText(userText);
  if (cleanText.length < 2) {
    logger?.debug?.(`${TAG} Query too short for memory search (raw=${userText.length}, clean=${cleanText.length})`);
    return emptyResult;
  }
  if (cleanText.length !== userText.length) {
    logger?.debug?.(`${TAG} userText sanitized: ${userText.length} → ${cleanText.length} chars`);
  }

  const maxResults = cfg.recall.maxResults ?? 5;
  const threshold = cfg.recall.scoreThreshold ?? 0.2;
  const typeWeights = cfg.recall.typeWeights;
  const mode = cfg.recall.crossProject ?? "hidden";
  const scopeDecayCfg: ScopeDecayConfig = {
    crossProjectDecay: cfg.recall.crossProjectDecay,
    defaultCrossProjectMultiplier: cfg.recall.defaultCrossProjectMultiplier,
    projectMap: cfg.recall.projectMap,
  };
  const embeddingAvailable = !!vectorStore && !!embeddingService;

  logger?.debug?.(
    `${TAG} [searchMemories] strategy=${strategy}, embeddingAvailable=${embeddingAvailable}, ` +
    `vectorStore=${vectorStore ? "available" : "UNAVAILABLE"}, ` +
    `embeddingService=${embeddingService ? "available" : "UNAVAILABLE"}, ` +
    `maxResults=${maxResults}, threshold=${threshold}`,
  );

  let effectiveStrategy = strategy;
  if ((strategy === "embedding" || strategy === "hybrid") && !embeddingAvailable) {
    logger?.warn?.(`${TAG} Strategy "${strategy}" requested but EmbeddingService not available, falling back to keyword`);
    effectiveStrategy = "keyword";
  }
  logger?.debug?.(`${TAG} Search strategy: ${effectiveStrategy} (configured: ${strategy})`);

  const recallEmbeddingTimeoutMs = cfg.embedding?.recallTimeoutMs ?? cfg.embedding?.timeoutMs;
  const embeddingCallOpts: EmbeddingCallOptions = { timeoutMs: recallEmbeddingTimeoutMs };

  try {
    if (effectiveStrategy === "keyword") {
      const tFts = performance.now();
      const lines = await searchByKeyword(cleanText, pluginDataDir, maxResults, threshold, logger, vectorStore, projectId, scopeDecayCfg, mode);
      return { lines, timing: { ftsMs: performance.now() - tFts, embeddingMs: 0, ftsHits: lines.length, embeddingHits: 0 } };
    }
    if (effectiveStrategy === "embedding") {
      const tEmb = performance.now();
      const lines = await searchByEmbedding(cleanText, maxResults, threshold, vectorStore!, embeddingService!, logger, embeddingCallOpts, projectId, typeWeights, scopeDecayCfg, mode);
      return { lines, timing: { ftsMs: 0, embeddingMs: performance.now() - tEmb, ftsHits: 0, embeddingHits: lines.length } };
    }
    // Hybrid: short-circuit to single store-side call when supported.
    if (vectorStore?.getCapabilities().nativeHybridSearch) {
      const tNative = performance.now();
      // TODO: thread mode + projectId through searchL1Hybrid when tcvdb
      // adds them to its impl signature (interface already accepts them).
      const results = (await vectorStore.searchL1Hybrid!({ query: cleanText, topK: maxResults }))
        .filter((r) => passesScope(r, projectId, mode));
      const nativeMs = performance.now() - tNative;
      logger?.debug?.(`${TAG} [hybrid-native] Single-call hybrid: ${results.length} results in ${nativeMs.toFixed(0)}ms, mode=${mode}`);
      const { formatMemoryLine, vectorResultToFormatable } = await import("./format.js");
      const lines = results.map((r) => formatMemoryLine(vectorResultToFormatable(r)));
      return { lines, timing: { ftsMs: 0, embeddingMs: nativeMs, ftsHits: 0, embeddingHits: results.length } };
    }
    return await searchHybrid(cleanText, pluginDataDir, maxResults, threshold, vectorStore!, embeddingService!, logger, embeddingCallOpts, projectId, typeWeights, scopeDecayCfg, mode);
  } catch (err) {
    logger?.warn?.(`${TAG} Memory search failed (strategy=${effectiveStrategy}): ${err instanceof Error ? err.message : String(err)}`);
    return emptyResult;
  }
}

// passesScope imported at the top of the file (alongside other strategy imports).
