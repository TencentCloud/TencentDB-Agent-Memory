/**
 * memory_search tool: Agent-callable tool for searching L1 memory records.
 *
 * Supports three search strategies with automatic degradation:
 *   1. **hybrid** (default) — FTS5 keyword + vector embedding in parallel,
 *      merged via Reciprocal Rank Fusion (RRF).
 *   2. **embedding** — pure vector similarity (when FTS5 is unavailable).
 *   3. **fts** — pure FTS5 keyword search (when embedding is unavailable).
 *
 * The tool is registered via `api.registerTool()` in index.ts.
 */

import type { IMemoryStore, L1SearchResult, SearchScopeOptions } from "../store/types.js";
import { buildFtsQuery } from "../store/sqlite.js";
import type { EmbeddingService } from "../store/embedding.js";

// ============================
// Types
// ============================

interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface MemorySearchResultItem {
  id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  session_key: string;
  session_id: string;
  score: number;
  created_at: string;
  updated_at: string;
}

export interface MemorySearchResult {
  results: MemorySearchResultItem[];
  total: number;
  strategy: string;
  /** Optional message, e.g. when embedding is not configured. */
  message?: string;
}

const TAG = "[memory-tdai][tdai_memory_search]";
const FILTERED_SEARCH_INITIAL_CANDIDATES = 50;

// ============================
// RRF (Reciprocal Rank Fusion)
// ============================

/** Standard RRF constant from the original RRF paper. */
const RRF_K = 60;

/**
 * Merge multiple ranked lists of `MemorySearchResultItem` via Reciprocal Rank
 * Fusion. Items appearing in multiple lists get their RRF scores summed.
 *
 * Returns items sorted by descending RRF score. The `score` field of each
 * returned item is replaced by the RRF score for consistent ranking semantics.
 */
function rrfMergeL1(...lists: MemorySearchResultItem[][]): MemorySearchResultItem[] {
  const map = new Map<string, { item: MemorySearchResultItem; rrfScore: number }>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const score = 1 / (RRF_K + rank + 1);
      const existing = map.get(item.id);
      if (existing) {
        existing.rrfScore += score;
      } else {
        map.set(item.id, { item, rrfScore: score });
      }
    }
  }

  return [...map.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(({ item, rrfScore }) => ({ ...item, score: rrfScore }));
}

// ============================
// Search implementation
// ============================

export async function executeMemorySearch(params: {
  query: string;
  limit: number;
  type?: string;
  scene?: string;
  sessionKeyPrefixes?: string[];
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  logger?: Logger;
}): Promise<MemorySearchResult> {
  const {
    query,
    limit,
    type: typeFilter,
    scene: sceneFilter,
    sessionKeyPrefixes,
    vectorStore,
    embeddingService,
    logger,
  } = params;
  const normalizedSessionPrefixes = normalizeSessionPrefixes(sessionKeyPrefixes);

  logger?.debug?.(
    `${TAG} CALLED: query="${query.slice(0, 100)}", limit=${limit}, ` +
    `typeFilter=${typeFilter ?? "(none)"}, sceneFilter=${sceneFilter ?? "(none)"}, ` +
    `sessionPrefixFilter=${normalizedSessionPrefixes.join("|") || "(none)"}, ` +
    `vectorStore=${vectorStore ? "available" : "UNAVAILABLE"}, ` +
    `embeddingService=${embeddingService ? "available" : "UNAVAILABLE"}`,
  );

  if (!query || query.trim().length === 0) {
    logger?.debug?.(`${TAG} Empty query, returning empty`);
    return { results: [], total: 0, strategy: "none" };
  }

  if (!vectorStore) {
    logger?.warn?.(`${TAG} VectorStore not available`);
    return { results: [], total: 0, strategy: "none" };
  }

  // ── Determine available capabilities ──
  const hasEmbedding = !!embeddingService;
  const hasFts = vectorStore.isFtsAvailable();

  if (!hasEmbedding && !hasFts) {
    logger?.warn?.(`${TAG} Neither EmbeddingService nor FTS5 available — cannot search`);
    return {
      results: [],
      total: 0,
      strategy: "none",
      message:
        "Embedding service is not configured and FTS is not available. " +
        "Memory search requires an embedding provider or FTS5 support. " +
        "Please configure an embedding provider in the embedding.provider setting (e.g. openai_compatible).",
    };
  }

  const searchScope: SearchScopeOptions | undefined = normalizedSessionPrefixes.length > 0
    ? { sessionKeyPrefixes: normalizedSessionPrefixes }
    : undefined;
  const candidateK = normalizedSessionPrefixes.length > 0
    ? Math.max(limit * 6, FILTERED_SEARCH_INITIAL_CANDIDATES)
    : limit * 3;

  const search = await collectMemoryCandidates({
    query,
    candidateK,
    hasFts,
    hasEmbedding,
    vectorStore,
    embeddingService,
    searchScope,
    logger,
  });

  if (search.results.length === 0) {
    logger?.debug?.(`${TAG} Both search paths returned 0 results`);
    return { results: [], total: 0, strategy: hasEmbedding ? "embedding" : "fts" };
  }

  const filtered = filterMemoryResults(search.results, {
    typeFilter,
    sceneFilter,
    sessionPrefixes: normalizedSessionPrefixes,
    logger,
  });
  const trimmed = filtered.slice(0, limit);

  logger?.debug?.(
    `${TAG} RESULT (strategy=${search.strategy}, candidateK=${candidateK}): returning ${trimmed.length} memories ` +
    `(scores: [${trimmed.map((r) => r.score.toFixed(3)).join(", ")}])`,
  );

  return {
    results: trimmed,
    total: trimmed.length,
    strategy: search.strategy,
  };
}

async function collectMemoryCandidates(params: {
  query: string;
  candidateK: number;
  hasFts: boolean;
  hasEmbedding: boolean;
  vectorStore: IMemoryStore;
  embeddingService?: EmbeddingService;
  searchScope?: SearchScopeOptions;
  logger?: Logger;
}): Promise<{ results: MemorySearchResultItem[]; strategy: string; mayHaveMore: boolean }> {
  const { query, candidateK, hasFts, hasEmbedding, vectorStore, embeddingService, searchScope, logger } = params;

  const [ftsItems, vecItems] = await Promise.all([
    (async (): Promise<MemorySearchResultItem[]> => {
      if (!hasFts) return [];
      try {
        const ftsQuery = buildFtsQuery(query);
        if (!ftsQuery) {
          logger?.debug?.(`${TAG} [hybrid-fts] No usable FTS tokens from query`);
          return [];
        }
        logger?.debug?.(`${TAG} [hybrid-fts] FTS5 query: "${ftsQuery}"`);
        const ftsResults = await vectorStore.searchL1Fts(ftsQuery, candidateK, searchScope);
        logger?.debug?.(`${TAG} [hybrid-fts] FTS5 returned ${ftsResults.length} candidates`);
        return ftsResults.map(memoryResultItemFromStore);
      } catch (err) {
        logger?.warn?.(
          `${TAG} [hybrid-fts] FTS5 search failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }
    })(),
    (async (): Promise<MemorySearchResultItem[]> => {
      if (!hasEmbedding) return [];
      try {
        logger?.debug?.(`${TAG} [hybrid-vec] Generating query embedding...`);
        const queryEmbedding = await embeddingService!.embed(query);
        logger?.debug?.(
          `${TAG} [hybrid-vec] Embedding OK, dims=${queryEmbedding.length}, searching top-${candidateK}...`,
        );
        const vecResults: L1SearchResult[] = await vectorStore.searchL1Vector(queryEmbedding, candidateK, query, searchScope);
        logger?.debug?.(`${TAG} [hybrid-vec] Vector search returned ${vecResults.length} candidates`);
        return vecResults.map(memoryResultItemFromStore);
      } catch (err) {
        logger?.warn?.(
          `${TAG} [hybrid-vec] Embedding search failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }
    })(),
  ]);

  const ftsOk = ftsItems.length > 0;
  const vecOk = vecItems.length > 0;
  const strategy = ftsOk && vecOk ? "hybrid" : vecOk ? "embedding" : ftsOk ? "fts" : "none";
  const results = strategy === "hybrid"
    ? rrfMergeL1(ftsItems, vecItems)
    : ftsOk ? ftsItems : vecItems;

  if (strategy === "hybrid") {
    logger?.debug?.(
      `${TAG} [hybrid] RRF merged: fts=${ftsItems.length}, vec=${vecItems.length} → ${results.length} unique`,
    );
  }

  return {
    results,
    strategy,
    mayHaveMore: (hasFts && ftsItems.length >= candidateK) || (hasEmbedding && vecItems.length >= candidateK),
  };
}

function memoryResultItemFromStore(r: L1SearchResult): MemorySearchResultItem {
  return {
    id: r.record_id,
    content: r.content,
    type: r.type,
    priority: r.priority,
    scene_name: r.scene_name,
    session_key: r.session_key,
    session_id: r.session_id,
    score: r.score,
    created_at: r.timestamp_start,
    updated_at: r.timestamp_end,
  };
}

function filterMemoryResults(
  results: MemorySearchResultItem[],
  filters: {
    typeFilter?: string;
    sceneFilter?: string;
    sessionPrefixes: string[];
    logger?: Logger;
  },
): MemorySearchResultItem[] {
  const { typeFilter, sceneFilter, sessionPrefixes, logger } = filters;
  const preFilterCount = results.length;
  let filtered = results;
  if (typeFilter) {
    filtered = filtered.filter((r) => r.type === typeFilter);
    logger?.debug?.(`${TAG} After type filter "${typeFilter}": ${filtered.length}/${preFilterCount}`);
  }
  if (sceneFilter) {
    const normalizedScene = sceneFilter.toLowerCase();
    filtered = filtered.filter((r) =>
      r.scene_name.toLowerCase().includes(normalizedScene),
    );
    logger?.debug?.(`${TAG} After scene filter "${sceneFilter}": ${filtered.length}/${preFilterCount}`);
  }
  if (sessionPrefixes.length > 0) {
    const beforeSessionFilter = filtered.length;
    filtered = filtered.filter((r) =>
      sessionPrefixes.some((prefix) => r.session_key.startsWith(prefix)),
    );
    logger?.debug?.(`${TAG} After session-prefix filter: ${filtered.length}/${beforeSessionFilter}`);
  }
  return filtered;
}

function normalizeSessionPrefixes(prefixes: string[] | undefined): string[] {
  if (!Array.isArray(prefixes)) return [];
  return prefixes
    .map((prefix) => typeof prefix === "string" ? prefix.trim() : "")
    .filter(Boolean)
    .slice(0, 20);
}

// ============================
// Tool response formatter
// ============================

export function formatSearchResponse(result: MemorySearchResult): string {
  if (result.message) {
    return result.message;
  }
  if (result.results.length === 0) {
    return "No matching memories found.";
  }

  const lines: string[] = [
    `Found ${result.total} matching memories:`,
    "",
  ];

  for (const item of result.results) {
    const scoreStr = typeof item.score === "number" ? ` (score: ${item.score.toFixed(3)})` : "";
    const sceneStr = item.scene_name ? ` [scene: ${item.scene_name}]` : "";
    const priorityStr = item.priority >= 0 ? ` (priority: ${item.priority})` : " (global instruction)";
    lines.push(`- **[${item.type}]**${priorityStr}${sceneStr}${scoreStr}`);
    lines.push(`  ${item.content}`);
    lines.push("");
  }

  return lines.join("\n");
}
