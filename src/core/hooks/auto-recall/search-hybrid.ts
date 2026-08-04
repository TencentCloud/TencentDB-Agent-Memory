/** Strategy: Hybrid (Keyword + Embedding in parallel, RRF merge with k=60). */

import type { EmbeddingCallOptions, EmbeddingService } from "../../store/embedding.js";
import type { MemoryRecord } from "../../record/l1-reader.js";
import type { L1SearchResult, IMemoryStore } from "../../store/types.js";
import type { Logger } from "../../types.js";
import { TAG, type FormatableMemory, type ScoredRecord, type SearchResult, type TypeWeights } from "./types.js";
import { passesScope } from "./scope.js";
import { scopeDecayMultiplier, type ScopeDecayConfig } from "./scope-decay.js";
import { formatMemoryLine, recordToFormatable, vectorResultToFormatable } from "./format.js";
import { buildFtsQuery } from "../../store/sqlite.js";

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
  mode: "hidden" | "decay" = "hidden",
): Promise<SearchResult> {
  const candidateK = maxResults * (projectId ? 6 : 3);
  const [keywordResult, embeddingResult] = await Promise.all([
    runKeywordPart(userText, vectorStore, candidateK, projectId, logger, scopeDecayCfg, mode),
    runEmbeddingPart(userText, vectorStore, embeddingService, candidateK, embeddingCallOpts, projectId, logger, scopeDecayCfg, mode),
  ]);
  const keywordResults = keywordResult.records;
  const embeddingResults = embeddingResult.results;
  const timing = { ftsMs: keywordResult.ms, embeddingMs: embeddingResult.ms, ftsHits: keywordResults.length, embeddingHits: embeddingResults.length };
  if (keywordResults.length === 0 && embeddingResults.length === 0) {
    logger?.debug?.(`${TAG} Hybrid search: both strategies returned 0 results`);
    return { lines: [], timing };
  }
  const mergedMap = new Map<string, { rrfScore: number; formatable: FormatableMemory; scope?: string; project_id?: string }>();
  for (let rank = 0; rank < keywordResults.length; rank++) {
    const r = keywordResults[rank]!;
    const id = r.record.id;
    const rrfScore = 1 / (RRF_K + rank + 1);
    const existing = mergedMap.get(id);
    if (existing) existing.rrfScore += rrfScore;
    else mergedMap.set(id, { rrfScore, formatable: recordToFormatable(r.record), scope: r.record.projectId });
  }
  for (let rank = 0; rank < embeddingResults.length; rank++) {
    const r = embeddingResults[rank]!;
    const id = r.record_id;
    const rrfScore = 1 / (RRF_K + rank + 1);
    const existing = mergedMap.get(id);
    if (existing) existing.rrfScore += rrfScore;
    else mergedMap.set(id, { rrfScore, formatable: vectorResultToFormatable(r), scope: r.scope, project_id: r.project_id });
  }
  // Type rerank (improvement #2): multiply fused RRF score by type weight, re-sort BEFORE top-K.
  // Hybrid cross-project semantics: multiplier applies to RRF (1/(60+rank+1)), not cosine.
  // RRF and cosine live on different scales; the multiplier is a soft signal here.
  const entries = [...mergedMap.entries()].map(([id, v]) => ({
    id,
    rrfScore:
      v.rrfScore *
      (typeWeights && typeWeights[v.formatable.type as "instruction" | "persona" | "episodic"] != null
        ? typeWeights[v.formatable.type as "instruction" | "persona" | "episodic"]!
        : 1) *
      scopeDecayMultiplier({ scope: v.scope, project_id: v.project_id }, projectId, scopeDecayCfg),
    formatable: v.formatable,
  }));
  const sorted = entries.sort((a, b) => b.rrfScore - a.rrfScore).slice(0, maxResults);
  if (sorted.length > 0) {
    logger?.debug?.(`${TAG} Hybrid search found ${sorted.length} results (keyword=${keywordResults.length}, embedding=${embeddingResults.length})`);
    return { lines: sorted.map((e) => formatMemoryLine(e.formatable)), timing };
  }
  logger?.debug?.(`${TAG} Hybrid search: no results after merge`);
  return { lines: [], timing };
}

async function runKeywordPart(
  userText: string,
  vectorStore: IMemoryStore,
  candidateK: number,
  projectId: string,
  logger?: Logger,
  _scopeDecayCfg?: ScopeDecayConfig,
  mode: "hidden" | "decay" = "hidden",
): Promise<{ records: ScoredRecord[]; ms: number }> {
  const tStart = performance.now();
  try {
    if (vectorStore.isFtsAvailable()) {
      const ftsQuery = buildFtsQuery(userText);
      if (ftsQuery) {
        const ftsResults = (await vectorStore.searchL1Fts(ftsQuery, candidateK, projectId, mode))
          .filter((r) => passesScope(r, projectId, mode));
        if (ftsResults.length > 0) {
          logger?.debug?.(`${TAG} [hybrid-keyword-fts] FTS5 found ${ftsResults.length} candidates`);
          const records = ftsResults.map((r): ScoredRecord => ({
            record: {
              id: r.record_id, content: r.content, type: r.type as MemoryRecord["type"],
              priority: r.priority, scene_name: r.scene_name, source_message_ids: [],
              metadata: r.metadata_json ? (() => { try { return JSON.parse(r.metadata_json); } catch { return {}; } })() : {},
              timestamps: [r.timestamp_str].filter(Boolean), createdAt: "", updatedAt: "",
              sessionKey: r.session_key, sessionId: r.session_id,
            },
            score: r.score,
          }));
          return { records, ms: performance.now() - tStart };
        }
      }
    }
    logger?.debug?.(`${TAG} [hybrid-keyword] FTS5 unavailable or no results, skipping keyword part`);
    return { records: [], ms: performance.now() - tStart };
  } catch (err) {
    logger?.warn?.(`${TAG} Hybrid: keyword part failed: ${err instanceof Error ? err.message : String(err)}`);
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
  logger?: Logger,
  _scopeDecayCfg?: ScopeDecayConfig,
  mode: "hidden" | "decay" = "hidden",
): Promise<{ results: L1SearchResult[]; ms: number }> {
  const tStart = performance.now();
  try {
    logger?.debug?.(`${TAG} [hybrid-embedding] Generating query embedding...`);
    const queryEmbedding = await embeddingService.embed(userText, embeddingCallOpts);
    logger?.debug?.(`${TAG} [hybrid-embedding] Embedding OK, dims=${queryEmbedding.length}, searching top-${candidateK}, mode=${mode}...`);
    const results = (await vectorStore.searchL1Vector(queryEmbedding, candidateK, userText, projectId, mode))
      .filter((r) => passesScope(r, projectId, mode));
    logger?.debug?.(`${TAG} [hybrid-embedding] Got ${results.length} candidates`);
    return { results, ms: performance.now() - tStart };
  } catch (err) {
    logger?.warn?.(`${TAG} Hybrid: embedding part failed: ${err instanceof Error ? err.message : String(err)}`);
    return { results: [], ms: performance.now() - tStart };
  }
}
