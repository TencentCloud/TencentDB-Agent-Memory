/**
 * Shared L1 candidate recall: text → top-K L1 hits.
 *
 * Used by memory_search (cross-session filter) and l1_dedup (session-scoped
 * filter). Callers own isolation / topK / query; this module only decides
 * native-hybrid vs FTS ∥ client-vector, then RRF-merges dual-path results.
 *
 * Native hybrid (TCVDB dense+sparse) is attempted before any client-embed
 * gate so NoopEmbeddingService does not block server-side search.
 */

import type { IMemoryStore, IsolationFilter, L1FtsResult, L1SearchResult } from "../store/types.js";
import { buildFtsQuery } from "../store/tokenize.js";
import { hasClientEmbedding, type EmbeddingService } from "../store/embedding.js";
import type { Logger } from "../types.js";

const DEFAULT_TAG = "[memory-tdai][l1-candidate-recall]";

/** Standard RRF constant from the original RRF paper. */
const RRF_K = 60;

export type L1RecallStrategy = "hybrid" | "embedding" | "fts" | "none";

export interface RecallL1CandidatesParams {
  query: string;
  topK: number;
  vectorStore: IMemoryStore;
  embeddingService?: EmbeddingService;
  logger?: Logger;
  filter?: IsolationFilter;
  /** Precomputed query vector; skips embed() on the client-vector path. */
  queryEmbedding?: Float32Array;
  embeddingTimeoutMs?: number;
  /** Log prefix so search/dedup keep their existing tag in logs. */
  logTag?: string;
}

export interface RecallL1CandidatesResult {
  hits: L1SearchResult[];
  strategy: L1RecallStrategy;
}

export async function recallL1Candidates(
  params: RecallL1CandidatesParams,
): Promise<RecallL1CandidatesResult> {
  const {
    query,
    topK,
    vectorStore,
    embeddingService,
    logger,
    filter,
    queryEmbedding,
    embeddingTimeoutMs,
  } = params;
  const tag = params.logTag ?? DEFAULT_TAG;

  if (!query || query.trim().length === 0 || topK <= 0) {
    return { hits: [], strategy: "none" };
  }

  if (hasNativeL1Hybrid(vectorStore)) {
    logger?.debug?.(`${tag} [native-hybrid] Single-call hybrid search...`);
    const results = await vectorStore.searchL1Hybrid!(
      filter ? { query, topK, filter } : { query, topK },
    );
    return { hits: results, strategy: "hybrid" };
  }

  const hasEmbedding = hasClientEmbedding(embeddingService);
  const hasFts = vectorStore.isFtsAvailable();

  if (!hasEmbedding && !hasFts) {
    return { hits: [], strategy: "none" };
  }

  const [ftsHits, vecHits] = await Promise.all([
    recallFts(query, topK, vectorStore, hasFts, filter, logger, tag),
    recallVector(
      query,
      topK,
      vectorStore,
      hasEmbedding ? embeddingService : undefined,
      filter,
      queryEmbedding,
      embeddingTimeoutMs,
      logger,
      tag,
    ),
  ]);

  const ftsOk = ftsHits.length > 0;
  const vecOk = vecHits.length > 0;
  let strategy: L1RecallStrategy;
  if (ftsOk && vecOk) {
    strategy = "hybrid";
  } else if (vecOk) {
    strategy = "embedding";
  } else if (ftsOk) {
    strategy = "fts";
  } else {
    logger?.debug?.(`${tag} Both search paths returned 0 results`);
    return { hits: [], strategy: hasEmbedding ? "embedding" : "fts" };
  }

  if (strategy === "hybrid") {
    const merged = rrfMergeL1Hits(ftsHits, vecHits);
    logger?.debug?.(
      `${tag} [hybrid] RRF merged: fts=${ftsHits.length}, vec=${vecHits.length} → ${merged.length} unique`,
    );
    return { hits: merged, strategy };
  }

  return { hits: ftsOk ? ftsHits : vecHits, strategy };
}

function hasNativeL1Hybrid(store: IMemoryStore): boolean {
  return (
    typeof store.getCapabilities === "function" &&
    !!store.getCapabilities().nativeHybridSearch &&
    typeof store.searchL1Hybrid === "function"
  );
}

function toL1Hit(r: L1SearchResult | L1FtsResult): L1SearchResult {
  return {
    record_id: r.record_id,
    content: r.content,
    type: r.type,
    priority: r.priority,
    scene_name: r.scene_name,
    score: r.score,
    timestamp_str: r.timestamp_str,
    timestamp_start: r.timestamp_start,
    timestamp_end: r.timestamp_end,
    version: r.version ?? 0,
    session_key: r.session_key,
    session_id: r.session_id,
    team_id: r.team_id,
    task_id: r.task_id,
    user_id: r.user_id,
    agent_id: r.agent_id,
    metadata_json: r.metadata_json,
  };
}

function rrfMergeL1Hits(...lists: L1SearchResult[][]): L1SearchResult[] {
  const map = new Map<string, { item: L1SearchResult; rrfScore: number }>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const score = 1 / (RRF_K + rank + 1);
      const existing = map.get(item.record_id);
      if (existing) {
        existing.rrfScore += score;
      } else {
        map.set(item.record_id, { item, rrfScore: score });
      }
    }
  }

  return [...map.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(({ item, rrfScore }) => ({ ...item, score: rrfScore }));
}

async function recallFts(
  query: string,
  topK: number,
  vectorStore: IMemoryStore,
  hasFts: boolean,
  filter: IsolationFilter | undefined,
  logger: Logger | undefined,
  tag: string,
): Promise<L1SearchResult[]> {
  if (!hasFts) return [];
  try {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) {
      logger?.debug?.(`${tag} [hybrid-fts] No usable FTS tokens from query`);
      return [];
    }
    logger?.debug?.(`${tag} [hybrid-fts] FTS5 query: "${ftsQuery}"`);
    const ftsResults = filter
      ? await vectorStore.searchL1Fts(ftsQuery, topK, filter)
      : await vectorStore.searchL1Fts(ftsQuery, topK);
    logger?.debug?.(`${tag} [hybrid-fts] FTS5 returned ${ftsResults.length} candidates`);
    return ftsResults.map(toL1Hit);
  } catch (err) {
    logger?.warn?.(
      `${tag} [hybrid-fts] FTS5 search failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

async function recallVector(
  query: string,
  topK: number,
  vectorStore: IMemoryStore,
  embeddingService: EmbeddingService | undefined,
  filter: IsolationFilter | undefined,
  queryEmbedding: Float32Array | undefined,
  embeddingTimeoutMs: number | undefined,
  logger: Logger | undefined,
  tag: string,
): Promise<L1SearchResult[]> {
  if (!hasClientEmbedding(embeddingService) && !(queryEmbedding && queryEmbedding.length > 0)) {
    return [];
  }
  try {
    let vec = queryEmbedding && queryEmbedding.length > 0 ? queryEmbedding : undefined;
    if (!vec) {
      logger?.debug?.(`${tag} [hybrid-vec] Generating query embedding...`);
      vec = embeddingTimeoutMs != null
        ? await embeddingService!.embed(query, { timeoutMs: embeddingTimeoutMs })
        : await embeddingService!.embed(query);
    }
    if (!vec || vec.length === 0) {
      logger?.debug?.(`${tag} [hybrid-vec] Empty query embedding, skipping vector path`);
      return [];
    }
    logger?.debug?.(
      `${tag} [hybrid-vec] Embedding OK, dims=${vec.length}, searching top-${topK}...`,
    );
    const vecResults = filter
      ? await vectorStore.searchL1Vector(vec, topK, query, filter)
      : await vectorStore.searchL1Vector(vec, topK, query);
    logger?.debug?.(`${tag} [hybrid-vec] Vector search returned ${vecResults.length} candidates`);
    return vecResults.map(toL1Hit);
  } catch (err) {
    logger?.warn?.(
      `${tag} [hybrid-vec] Embedding search failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}
