/** Strategy: Embedding (VectorStore cosine). Per-type rerank BEFORE top-K. */

import type { EmbeddingCallOptions, EmbeddingService } from "../../store/embedding.js";
import type { L1SearchResult, IMemoryStore } from "../../store/types.js";
import type { Logger } from "../../types.js";
import { TAG, type TypeWeights } from "./types.js";
import { applyTypeWeights, passesScope } from "./scope.js";
import { formatMemoryLine, vectorResultToFormatable } from "./format.js";

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
): Promise<string[]> {
  logger?.debug?.(`${TAG} [embedding-search] START query="${userText.slice(0, 80)}...", maxResults=${maxResults}, threshold=${threshold}`);
  const queryEmbedding = await embeddingService.embed(userText, embeddingCallOpts);
  logger?.debug?.(
    `${TAG} [embedding-search] Query embedding OK: dims=${queryEmbedding.length}, ` +
    `norm=${Math.sqrt(Array.from(queryEmbedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}, ` +
    `searching top-${maxResults * 2}...`,
  );
  const vecResults: L1SearchResult[] = (
    await vectorStore.searchL1Vector(queryEmbedding, maxResults * 2, userText, projectId)
  ).filter((r) => passesScope(r, projectId));
  if (vecResults.length === 0) { logger?.debug?.(`${TAG} [embedding-search] Returned 0 results`); return []; }
  logger?.debug?.(`${TAG} [embedding-search] Got ${vecResults.length} candidates, filtering by threshold=${threshold}`);
  for (const r of vecResults) {
    logger?.debug?.(
      `${TAG} [embedding-search] candidate id=${r.record_id}, score=${r.score.toFixed(4)}, ` +
      `type=${r.type}, content="${r.content.slice(0, 60)}..."`,
    );
  }
  const filtered = applyTypeWeights(
    vecResults.filter((r) => r.score >= threshold),
    typeWeights,
  ).slice(0, maxResults);
  if (filtered.length > 0) {
    logger?.debug?.(`${TAG} [embedding-search] Found ${filtered.length} relevant memories above threshold (from ${vecResults.length} candidates)`);
    return filtered.map((r) => formatMemoryLine(vectorResultToFormatable(r)));
  }
  logger?.debug?.(`${TAG} [embedding-search] No results above threshold ${threshold}`);
  return [];
}
