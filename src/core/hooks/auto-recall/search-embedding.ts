/** Strategy: Embedding (VectorStore cosine). Per-type rerank BEFORE top-K. */

import type { EmbeddingCallOptions, EmbeddingService } from "../../store/embedding.js";
import type { L1SearchResult, IMemoryStore } from "../../store/types.js";
import type { Logger } from "../../types.js";
import { TAG, type RecallDiagnostic, type RecallItem, type StrategyResult, type TypeWeights } from "./types.js";
import { filterByScope } from "./scope.js";
import { scopeDecayMultiplier, type ScopeDecayConfig } from "./scope-decay.js";
import { vectorResultToItem } from "./item.js";
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
): Promise<StrategyResult> {
  const diagnostics: RecallDiagnostic[] = [];
  logger?.debug?.(`${TAG} [embedding-search] START query="${userText.slice(0, 80)}...", maxResults=${maxResults}, threshold=${threshold}`);
  const queryEmbedding = await embeddingService.embed(userText, { ...embeddingCallOpts, inputType: "query" });
  logger?.debug?.(
    `${TAG} [embedding-search] Query embedding OK: dims=${queryEmbedding.length}, ` +
    `norm=${Math.sqrt(Array.from(queryEmbedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}, ` +
    `searching top-${maxResults * 2}...`,
  );
  // In decay mode, over-fetch more (×6) to compensate for cross-project rows
  // that will be downweighted (not filtered) by the SQL layer.
  const candidateK = mode === "decay" ? maxResults * 6 : maxResults * 2;
  const vecResults: L1SearchResult[] = filterByScope(
    await vectorStore.searchL1Vector(queryEmbedding, candidateK, userText, projectId, mode),
    projectId,
    mode,
    diagnostics,
  );
  if (vecResults.length === 0) { logger?.debug?.(`${TAG} [embedding-search] Returned 0 results`); return { items: [], diagnostics }; }
  logger?.debug?.(`${TAG} [embedding-search] Got ${vecResults.length} candidates, threshold=${threshold}, mode=${mode}`);
  // Multiplier BEFORE threshold (per critic pipeline-order) — otherwise raw
  // cosine<threshold records are discarded before decay can rescue them.
  // Pre-sort by post-multiplier score DESC so the type rerank sees the right
  // order (it sorts by weighted score using the item's final score).
  //
  // Order of operations is preserved from before tz-10a: the threshold looks
  // at the DECAYED score only, the type weight decides the ranking. Filtering
  // first and reranking after is equivalent (the filter keeps relative order)
  // and keeps the type weight out of the pass/fail decision — moving that
  // boundary would be a recall-formula change, which belongs to tz-04.
  const decayed = [...vecResults]
    .map((r) => toItem(r, projectId, scopeDecayCfg))
    .sort((a, b) => b.score.final - a.score.final)
    .filter((i) => i.score.final >= threshold);
  const filtered = applyTypeWeightsToItems(decayed, typeWeights).slice(
    0,
    maxResults,
  );
  if (filtered.length > 0) {
    logger?.debug?.(
      `${TAG} [embedding-search] Found ${filtered.length} relevant memories above threshold (from ${vecResults.length} candidates)`,
    );
    return { items: filtered, diagnostics };
  }
  logger?.debug?.(
    `${TAG} [embedding-search] No results above threshold ${threshold}`,
  );
  return { items: [], diagnostics };
}

/** One vector hit → item, with the decay multiplier recorded as a reason. */
function toItem(
  r: L1SearchResult,
  projectId: string,
  scopeDecayCfg: ScopeDecayConfig | undefined,
): RecallItem {
  const multiplier = scopeDecayMultiplier(r, projectId, scopeDecayCfg);
  return vectorResultToItem(r, {
    raw: r.score,
    final: r.score * multiplier,
    reasons: ["cosine", `decay:${multiplier}`],
  });
}

/**
 * Type rerank over items. Same rule as `applyTypeWeights` (weight multiplies
 * the score BEFORE top-K), but it rewrites `score.final` and records the
 * weight as a reason instead of only re-sorting — an item has to be able to
 * explain why it outranked a higher-cosine neighbour (tz-10 C10.3).
 */
function applyTypeWeightsToItems(
  items: RecallItem[],
  weights: TypeWeights,
): RecallItem[] {
  if (!weights) return items;
  if (
    weights.instruction === 1 &&
    weights.persona === 1 &&
    weights.episodic === 1
  )
    return items;
  const weightOf = (type: string): number => {
    if (type === "instruction") return weights.instruction;
    if (type === "persona") return weights.persona;
    if (type === "episodic") return weights.episodic;
    return 1;
  };
  return items
    .map((item) => {
      const w = weightOf(item.formatable.type);
      if (w === 1) return item;
      return {
        ...item,
        score: {
          ...item.score,
          final: item.score.final * w,
          reasons: [...item.score.reasons, `type-weight:${w}`],
        },
      };
    })
    .sort((a, b) => b.score.final - a.score.final);
}
