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
import type {
  EmbeddingCallOptions,
  EmbeddingService,
} from "../../store/embedding.js";
import type { IMemoryStore } from "../../store/types.js";
import type { Logger } from "../../types.js";
import {
  TAG,
  type RecallDiagnostic,
  type RecallItem,
  type RecallStrategy,
  type SearchResult,
  type SearchTiming,
  type TypeWeights,
} from "./types.js";
import { searchByKeyword } from "./search-keyword.js";
import { searchByEmbedding } from "./search-embedding.js";
import { searchHybrid } from "./search-hybrid.js";
import { filterByScope, type ScopeMode } from "./scope.js";
import { renderItems, vectorResultToItem } from "./item.js";
import type { ScopeDecayConfig } from "./scope-decay.js";

/**
 * A fresh empty result per call. It used to be one shared module-level object;
 * now that a result carries diagnostics, sharing it would let one call's
 * failure show up in another's.
 */
function emptyResult(diagnostics: RecallDiagnostic[] = []): SearchResult {
  return {
    lines: [],
    items: [],
    timing: { ftsMs: 0, embeddingMs: 0, ftsHits: 0, embeddingHits: 0 },
    diagnostics,
  };
}

/** Render the items once and pack the result the callers expect. */
function finish(
  items: RecallItem[],
  diagnostics: RecallDiagnostic[],
  timing: SearchTiming,
): SearchResult {
  return { lines: renderItems(items), items, timing, diagnostics };
}

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
    logger?.debug?.(
      `${TAG} Query too short for memory search (raw=${userText.length}, clean=${cleanText.length})`,
    );
    return emptyResult([
      {
        stage: "strategy",
        code: "query-too-short",
        message: `raw=${userText.length}, clean=${cleanText.length}, min=2`,
      },
    ]);
  }
  if (cleanText.length !== userText.length) {
    logger?.debug?.(
      `${TAG} userText sanitized: ${userText.length} → ${cleanText.length} chars`,
    );
  }

  const maxResults = cfg.recall.maxResults ?? 5;
  const threshold = cfg.recall.scoreThreshold ?? 0.2;
  const typeWeights = cfg.recall.typeWeights;
  // One knob reaches every implementation of the predicate: JS here, the SQL
  // mirror in sqlite.ts, and the TCVDB filter. `scopeFilter` only sharpens the
  // filtering mode — in `decay` nothing is filtered, so it does not apply.
  const crossProject = cfg.recall.crossProject ?? "hidden";
  const mode: ScopeMode =
    crossProject === "decay"
      ? "decay"
      : cfg.recall.scopeFilter === "attribute"
        ? "strict"
        : "hidden";
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

  const diagnostics: RecallDiagnostic[] = [];
  let effectiveStrategy = strategy;
  if (
    (strategy === "embedding" || strategy === "hybrid") &&
    !embeddingAvailable
  ) {
    logger?.warn?.(
      `${TAG} Strategy "${strategy}" requested but EmbeddingService not available, falling back to keyword`,
    );
    diagnostics.push({
      stage: "strategy",
      code: "embedding-unavailable",
      message: `strategy "${strategy}" fell back to keyword: vectorStore=${vectorStore ? "ok" : "missing"}, embeddingService=${embeddingService ? "ok" : "missing"}`,
    });
    effectiveStrategy = "keyword";
  }
  logger?.debug?.(
    `${TAG} Search strategy: ${effectiveStrategy} (configured: ${strategy})`,
  );

  const recallEmbeddingTimeoutMs =
    cfg.embedding?.recallTimeoutMs ?? cfg.embedding?.timeoutMs;
  const embeddingCallOpts: EmbeddingCallOptions = {
    timeoutMs: recallEmbeddingTimeoutMs,
  };

  try {
    if (effectiveStrategy === "keyword") {
      const tFts = performance.now();
      const result = await searchByKeyword(
        cleanText,
        pluginDataDir,
        maxResults,
        threshold,
        logger,
        vectorStore,
        projectId,
        scopeDecayCfg,
        mode,
      );
      return finish(result.items, [...diagnostics, ...result.diagnostics], {
        ftsMs: performance.now() - tFts,
        embeddingMs: 0,
        ftsHits: result.items.length,
        embeddingHits: 0,
      });
    }
    if (effectiveStrategy === "embedding") {
      const tEmb = performance.now();
      const result = await searchByEmbedding(
        cleanText,
        maxResults,
        threshold,
        vectorStore!,
        embeddingService!,
        logger,
        embeddingCallOpts,
        projectId,
        typeWeights,
        scopeDecayCfg,
        mode,
      );
      return finish(result.items, [...diagnostics, ...result.diagnostics], {
        ftsMs: 0,
        embeddingMs: performance.now() - tEmb,
        ftsHits: 0,
        embeddingHits: result.items.length,
      });
    }
    // Hybrid: short-circuit to single store-side call when supported.
    if (vectorStore?.getCapabilities().nativeHybridSearch) {
      const tNative = performance.now();
      // Both backends now filter store-side; the JS scope leg stays for a store
      // that ignores the params (the three implementations are pinned to one
      // table in scope-sync.test.ts).
      const results = filterByScope(
        await vectorStore.searchL1Hybrid!({
          query: cleanText,
          topK: maxResults,
          projectId,
          mode,
        }),
        projectId,
        mode,
        diagnostics,
      );
      const nativeMs = performance.now() - tNative;
      logger?.debug?.(
        `${TAG} [hybrid-native] Single-call hybrid: ${results.length} results in ${nativeMs.toFixed(0)}ms, mode=${mode}`,
      );
      // The store already ranked and (in decay mode) downweighted these rows,
      // so the score it returned IS the final one — no second multiplier here.
      const items = results.map((r) =>
        vectorResultToItem(r, { raw: r.score, final: r.score, reasons: ["native-hybrid"] }),
      );
      return finish(items, diagnostics, {
        ftsMs: 0,
        embeddingMs: nativeMs,
        ftsHits: 0,
        embeddingHits: results.length,
      });
    }
    const hybrid = await searchHybrid(
      cleanText,
      pluginDataDir,
      maxResults,
      threshold,
      vectorStore!,
      embeddingService!,
      logger,
      embeddingCallOpts,
      projectId,
      typeWeights,
      scopeDecayCfg,
      mode,
    );
    return finish(hybrid.items, [...diagnostics, ...hybrid.diagnostics], hybrid.timing);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.warn?.(
      `${TAG} Memory search failed (strategy=${effectiveStrategy}): ${message}`,
    );
    // Fail-open stays: the pipeline is not blocked. What changes is that the
    // caller can now tell a broken store from an empty memory (tz-10 C10.5).
    return emptyResult([
      ...diagnostics,
      { stage: "repo", code: "search-failed", message: `strategy=${effectiveStrategy}: ${message}` },
    ]);
  }
}
