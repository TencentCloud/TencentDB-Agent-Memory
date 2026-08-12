/** Strategy: Hybrid (Keyword + Embedding in parallel, RRF merge with k=60). */

import type {
  EmbeddingCallOptions,
  EmbeddingService,
} from "../../store/embedding.js";
import type { MemoryRecord } from "../../record/l1-reader.js";
import type {
  L1FtsResult,
  L1SearchResult,
  IMemoryStore,
} from "../../store/types.js";
import type { Logger } from "../../types.js";
import {
  TAG,
  type RecallDiagnostic,
  type RecallItem,
  type StrategyResult,
  type TypeWeights,
} from "./types.js";
import { filterByScope } from "./scope.js";
import { scopeDecayMultiplier, type ScopeDecayConfig } from "./scope-decay.js";
import { recordToItem, vectorResultToItem, withScore } from "./item.js";
import { buildFtsQuery } from "../../store/sqlite.js";
import type { ScopeMode } from "./scope.js";

const RRF_K = 60;

export async function searchHybrid(
  userText: string,
  _pluginDataDir: string,
  maxResults: number,
  _threshold: number,
  vectorStore: IMemoryStore,
  embeddingService: EmbeddingService,
  logger?: Logger,
  embeddingCallOpts?: EmbeddingCallOptions,
  projectId = "",
  typeWeights?: TypeWeights,
  scopeDecayCfg?: ScopeDecayConfig,
  mode: ScopeMode = "hidden",
): Promise<
  StrategyResult & {
    timing: {
      ftsMs: number;
      embeddingMs: number;
      ftsHits: number;
      embeddingHits: number;
    };
  }
> {
  const diagnostics: RecallDiagnostic[] = [];
  const candidateK = maxResults * (projectId ? 6 : 3);
  const [keywordResult, embeddingResult] = await Promise.all([
    runKeywordPart(
      userText,
      vectorStore,
      candidateK,
      projectId,
      mode,
      diagnostics,
      logger,
    ),
    runEmbeddingPart(
      userText,
      vectorStore,
      embeddingService,
      candidateK,
      embeddingCallOpts,
      projectId,
      mode,
      diagnostics,
      logger,
    ),
  ]);
  const keywordResults = keywordResult.records;
  const embeddingResults = embeddingResult.results;
  const timing = {
    ftsMs: keywordResult.ms,
    embeddingMs: embeddingResult.ms,
    ftsHits: keywordResults.length,
    embeddingHits: embeddingResults.length,
  };
  if (keywordResults.length === 0 && embeddingResults.length === 0) {
    logger?.debug?.(`${TAG} Hybrid search: both strategies returned 0 results`);
    return { items: [], diagnostics, timing };
  }
  const mergedMap = new Map<string, { rrfScore: number; item: RecallItem }>();
  for (let rank = 0; rank < keywordResults.length; rank++) {
    const r = keywordResults[rank]!;
    const id = r.record.id;
    const rrfScore = 1 / (RRF_K + rank + 1);
    const existing = mergedMap.get(id);
    if (existing) existing.rrfScore += rrfScore;
    // The FTS row's own `scope`/`project_id` travel with the item: a
    // MemoryRecord has no room for them, and dropping them here is what let a
    // keyword-only foreign-project hit escape the decay entirely (tz-10a Ф2b).
    else
      mergedMap.set(id, {
        rrfScore,
        item: recordToItem(
          r.record,
          zeroScore(),
          { scope: r.row.scope, project_id: r.row.project_id },
          "l1-hybrid-rrf",
        ),
      });
  }
  for (let rank = 0; rank < embeddingResults.length; rank++) {
    const r = embeddingResults[rank]!;
    const id = r.record_id;
    const rrfScore = 1 / (RRF_K + rank + 1);
    const existing = mergedMap.get(id);
    if (existing) existing.rrfScore += rrfScore;
    else
      mergedMap.set(id, {
        rrfScore,
        item: vectorResultToItem(r, zeroScore(), "l1-hybrid-rrf"),
      });
  }
  // Type rerank (improvement #2): multiply fused RRF score by type weight, re-sort BEFORE top-K.
  // Hybrid cross-project semantics: multiplier applies to RRF (1/(60+rank+1)), not cosine.
  // RRF and cosine live on different scales; the multiplier is a soft signal here.
  const entries = [...mergedMap.values()].map(({ rrfScore, item }) => {
    const weight = typeWeightOf(item.formatable.type, typeWeights);
    const decay = scopeDecayMultiplier(
      { scope: item.scope.scope, project_id: item.scope.projectId },
      projectId,
      scopeDecayCfg,
    );
    return withScore(item, {
      raw: rrfScore,
      final: rrfScore * weight * decay,
      reasons: ["rrf", `decay:${decay}`, `type-weight:${weight}`],
    });
  });
  const sorted = entries
    .sort((a, b) => b.score.final - a.score.final)
    .slice(0, maxResults);
  if (sorted.length > 0) {
    logger?.debug?.(
      `${TAG} Hybrid search found ${sorted.length} results (keyword=${keywordResults.length}, embedding=${embeddingResults.length})`,
    );
    return { items: sorted, diagnostics, timing };
  }
  logger?.debug?.(`${TAG} Hybrid search: no results after merge`);
  return { items: [], diagnostics, timing };
}

/** Placeholder score: the RRF fusion below is what actually scores an item. */
function zeroScore(): RecallItem["score"] {
  return { raw: 0, final: 0, reasons: [] };
}

function typeWeightOf(type: string, weights: TypeWeights): number {
  if (!weights) return 1;
  const w = weights[type as "instruction" | "persona" | "episodic"];
  return w != null ? w : 1;
}

/** One FTS hit as both a record (for rendering) and its raw row (for scope). */
interface KeywordHit {
  record: MemoryRecord;
  row: L1FtsResult;
}

async function runKeywordPart(
  userText: string,
  vectorStore: IMemoryStore,
  candidateK: number,
  projectId: string,
  mode: ScopeMode,
  diagnostics: RecallDiagnostic[],
  logger?: Logger,
): Promise<{ records: KeywordHit[]; ms: number }> {
  const tStart = performance.now();
  try {
    if (vectorStore.isFtsAvailable()) {
      const ftsQuery = buildFtsQuery(userText);
      if (ftsQuery) {
        const ftsResults = filterByScope(
          await vectorStore.searchL1Fts(ftsQuery, candidateK, projectId, mode),
          projectId,
          mode,
          diagnostics,
        );
        if (ftsResults.length > 0) {
          logger?.debug?.(
            `${TAG} [hybrid-keyword-fts] FTS5 found ${ftsResults.length} candidates`,
          );
          const records = ftsResults.map((r): KeywordHit => ({
            record: {
              id: r.record_id,
              content: r.content,
              type: r.type as MemoryRecord["type"],
              priority: r.priority,
              scene_name: r.scene_name,
              source_message_ids: [],
              metadata: r.metadata_json
                ? (() => {
                    try {
                      return JSON.parse(r.metadata_json);
                    } catch {
                      return {};
                    }
                  })()
                : {},
              timestamps: [r.timestamp_str].filter(Boolean),
              createdAt: "",
              updatedAt: "",
              sessionKey: r.session_key,
              sessionId: r.session_id,
            },
            row: r,
          }));
          return { records, ms: performance.now() - tStart };
        }
      }
    }
    logger?.debug?.(
      `${TAG} [hybrid-keyword] FTS5 unavailable or no results, skipping keyword part`,
    );
    return { records: [], ms: performance.now() - tStart };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.warn?.(`${TAG} Hybrid: keyword part failed: ${message}`);
    diagnostics.push({ stage: "repo", code: "keyword-leg-failed", message });
    return { records: [], ms: performance.now() - tStart };
  }
}

async function runEmbeddingPart(
  userText: string,
  vectorStore: IMemoryStore,
  embeddingService: EmbeddingService,
  candidateK: number,
  embeddingCallOpts: EmbeddingCallOptions | undefined,
  projectId: string,
  mode: ScopeMode,
  diagnostics: RecallDiagnostic[],
  logger?: Logger,
): Promise<{ results: L1SearchResult[]; ms: number }> {
  const tStart = performance.now();
  try {
    logger?.debug?.(`${TAG} [hybrid-embedding] Generating query embedding...`);
    const queryEmbedding = await embeddingService.embed(userText, {
      ...embeddingCallOpts,
      inputType: "query",
    });
    logger?.debug?.(
      `${TAG} [hybrid-embedding] Embedding OK, dims=${queryEmbedding.length}, searching top-${candidateK}, mode=${mode}...`,
    );
    const results = filterByScope(
      await vectorStore.searchL1Vector(
        queryEmbedding,
        candidateK,
        userText,
        projectId,
        mode,
      ),
      projectId,
      mode,
      diagnostics,
    );
    logger?.debug?.(
      `${TAG} [hybrid-embedding] Got ${results.length} candidates`,
    );
    return { results, ms: performance.now() - tStart };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.warn?.(`${TAG} Hybrid: embedding part failed: ${message}`);
    diagnostics.push({ stage: "repo", code: "embedding-leg-failed", message });
    return { results: [], ms: performance.now() - tStart };
  }
}
