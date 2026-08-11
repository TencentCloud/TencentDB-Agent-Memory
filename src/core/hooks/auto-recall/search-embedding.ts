/** Strategy: Embedding (VectorStore cosine). Per-type rerank BEFORE top-K. */

import type { EmbeddingCallOptions, EmbeddingService } from "../../store/embedding.js";
import type { L1SearchResult, IMemoryStore } from "../../store/types.js";
import type { Logger } from "../../types.js";
import { TAG, type TypeWeights } from "./types.js";
import { applyTypeWeights, passesScope } from "./scope.js";
import { scopeDecayMultiplier, type ScopeDecayConfig } from "./scope-decay.js";
import { formatMemoryLine, vectorResultToFormatable } from "./format.js";
import type { ScopeMode } from "./scope.js";

export async function searchByEmbedding(
  userText: string,
  maxResults: number,
  threshold: number,
  vectorStore: IMemoryStore,
  embeddingService: EmbeddingService,
  logger?: Logger,
  embeddingCallOpts?: EmbeddingCallOptions,
  projectId = "",
  typeWeights?: TypeWeights,
  scopeDecayCfg?: ScopeDecayConfig,
  mode: ScopeMode = "hidden",
): Promise<string[]> {
  logger?.debug?.(`${TAG} [embedding-search] START query="${userText.slice(0, 80)}...", maxResults=${maxResults}, threshold=${threshold}`);
  const queryEmbedding = await embeddingService.embed(userText, embeddingCallOpts);
  logger?.debug?.(
    `${TAG} [embedding-search] Query embedding OK: dims=${queryEmbedding.length}, ` +
    `norm=${Math.sqrt(Array.from(queryEmbedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}, ` +
    `searching top-${maxResults * 2}...`,
  );
  // In decay mode, over-fetch more (×6) to compensate for cross-project rows
  // that will be downweighted (not filtered) by the SQL layer.
  const candidateK = mode === "decay" ? maxResults * 6 : maxResults * 2;
  const vecResults: L1SearchResult[] = (
    await vectorStore.searchL1Vector(queryEmbedding, candidateK, userText, projectId, mode)
  ).filter((r) => passesScope(r, projectId, mode));
  if (vecResults.length === 0) { logger?.debug?.(`${TAG} [embedding-search] Returned 0 results`); return []; }
  logger?.debug?.(`${TAG} [embedding-search] Got ${vecResults.length} candidates, threshold=${threshold}, mode=${mode}`);
  // Multiplier BEFORE threshold (per critic pipeline-order) — otherwise raw
  // cosine<threshold records are discarded before decay can rescue them.
  // Pre-sort by post-multiplier score DESC so applyTypeWeights sees the right
  // order (it sorts by weighted score using item.score after this map).
  const decayed = applyTypeWeights(
    [...vecResults]
      .map((r) => ({
        ...r,
        score: r.score * scopeDecayMultiplier(r, projectId, scopeDecayCfg),
      }))
      .sort((a, b) => b.score - a.score),
    typeWeights,
  );
  const filtered = decayed
    .filter((r) => r.score >= threshold)
    .slice(0, maxResults);
  if (filtered.length > 0) {
    logger?.debug?.(`${TAG} [embedding-search] Found ${filtered.length} relevant memories above threshold (from ${vecResults.length} candidates)`);
    return filtered.map((r) => formatMemoryLine(vectorResultToFormatable(r)));
  }
  logger?.debug?.(`${TAG} [embedding-search] No results above threshold ${threshold}`);
  return [];
}
