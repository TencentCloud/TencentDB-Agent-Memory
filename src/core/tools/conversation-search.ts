/**
 * conversation_search tool: Agent-callable tool for searching L0 conversation records.
 *
 * Supports three search strategies with automatic degradation:
 *   1. **hybrid** (default) — FTS5 keyword + vector embedding in parallel,
 *      merged via Reciprocal Rank Fusion (RRF).
 *   2. **embedding** — pure vector similarity (when FTS5 is unavailable).
 *   3. **fts** — pure FTS5 keyword search (when embedding is unavailable).
 *
 * The tool is registered via `api.registerTool()` in index.ts.
 */

import type { IMemoryStore, L0SearchResult, SearchScopeOptions } from "../store/types.js";
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

export interface ConversationSearchResultItem {
  id: string;
  session_key: string;
  /** Role of the message sender: "user" or "assistant" */
  role: string;
  /** Text content of this single message */
  content: string;
  score: number;
  recorded_at: string;
}

export interface ConversationSearchResult {
  results: ConversationSearchResultItem[];
  total: number;
  /** Actual search strategy used: "hybrid", "embedding", "fts", or "none". */
  strategy: string;
  /** Optional message, e.g. when embedding is not configured. */
  message?: string;
}

const TAG = "[memory-tdai][tdai_conversation_search]";
const FILTERED_SEARCH_INITIAL_CANDIDATES = 50;

// ============================
// RRF (Reciprocal Rank Fusion)
// ============================

/** Standard RRF constant from the original RRF paper. */
const RRF_K = 60;

/**
 * Merge multiple ranked lists of `ConversationSearchResultItem` via Reciprocal
 * Rank Fusion. Items appearing in multiple lists get their RRF scores summed.
 *
 * Returns items sorted by descending RRF score. The `score` field of each
 * returned item is replaced by the RRF score for consistent ranking semantics.
 */
function rrfMergeL0(...lists: ConversationSearchResultItem[][]): ConversationSearchResultItem[] {
  const map = new Map<string, { item: ConversationSearchResultItem; rrfScore: number }>();

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

export async function executeConversationSearch(params: {
  query: string;
  limit: number;
  sessionKey?: string;
  sessionKeyPrefixes?: string[];
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  logger?: Logger;
}): Promise<ConversationSearchResult> {
  const {
    query,
    limit,
    sessionKey: sessionFilter,
    sessionKeyPrefixes,
    vectorStore,
    embeddingService,
    logger,
  } = params;
  const normalizedSessionPrefixes = normalizeSessionPrefixes(sessionKeyPrefixes);

  logger?.debug?.(
    `${TAG} CALLED: query="${query.slice(0, 100)}", limit=${limit}, ` +
    `sessionFilter=${sessionFilter ?? "(none)"}, ` +
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
        "Conversation search requires an embedding provider or FTS5 support. " +
        "Please configure an embedding provider in the embedding.provider setting (e.g. openai_compatible).",
    };
  }

  const hasSessionScope = !!sessionFilter || normalizedSessionPrefixes.length > 0;
  const searchScope: SearchScopeOptions | undefined = hasSessionScope
    ? {
        ...(sessionFilter ? { sessionKey: sessionFilter } : {}),
        sessionKeyPrefixes: normalizedSessionPrefixes,
      }
    : undefined;
  const candidateK = hasSessionScope
    ? Math.max(limit * 6, FILTERED_SEARCH_INITIAL_CANDIDATES)
    : limit * 3;

  const search = await collectConversationCandidates({
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

  const filtered = filterConversationResults(search.results, {
    sessionFilter,
    sessionPrefixes: normalizedSessionPrefixes,
    logger,
  });
  const trimmed = filtered.slice(0, limit);

  logger?.debug?.(
    `${TAG} RESULT (strategy=${search.strategy}, candidateK=${candidateK}): returning ${trimmed.length} messages ` +
    `(scores: [${trimmed.map((r) => r.score.toFixed(3)).join(", ")}])`,
  );

  return {
    results: trimmed,
    total: trimmed.length,
    strategy: search.strategy,
  };
}

async function collectConversationCandidates(params: {
  query: string;
  candidateK: number;
  hasFts: boolean;
  hasEmbedding: boolean;
  vectorStore: IMemoryStore;
  embeddingService?: EmbeddingService;
  searchScope?: SearchScopeOptions;
  logger?: Logger;
}): Promise<{ results: ConversationSearchResultItem[]; strategy: string; mayHaveMore: boolean }> {
  const { query, candidateK, hasFts, hasEmbedding, vectorStore, embeddingService, searchScope, logger } = params;

  const [ftsItems, vecItems] = await Promise.all([
    (async (): Promise<ConversationSearchResultItem[]> => {
      if (!hasFts) return [];
      try {
        const ftsQuery = buildFtsQuery(query);
        if (!ftsQuery) {
          logger?.debug?.(`${TAG} [hybrid-fts] No usable FTS tokens from query`);
          return [];
        }
        logger?.debug?.(`${TAG} [hybrid-fts] FTS5 query: "${ftsQuery}"`);
        const ftsResults = await vectorStore.searchL0Fts(ftsQuery, candidateK, searchScope);
        logger?.debug?.(`${TAG} [hybrid-fts] FTS5 returned ${ftsResults.length} candidates`);
        return ftsResults.map(conversationResultItemFromStore);
      } catch (err) {
        logger?.warn?.(
          `${TAG} [hybrid-fts] FTS5 search failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }
    })(),
    (async (): Promise<ConversationSearchResultItem[]> => {
      if (!hasEmbedding) return [];
      try {
        logger?.debug?.(`${TAG} [hybrid-vec] Generating query embedding...`);
        const queryEmbedding = await embeddingService!.embed(query);
        logger?.debug?.(
          `${TAG} [hybrid-vec] Embedding OK, dims=${queryEmbedding.length}, searching top-${candidateK}...`,
        );
        const vecResults: L0SearchResult[] = await vectorStore.searchL0Vector(queryEmbedding, candidateK, query, searchScope);
        logger?.debug?.(`${TAG} [hybrid-vec] Vector search returned ${vecResults.length} candidates`);
        return vecResults.map(conversationResultItemFromStore);
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
    ? rrfMergeL0(ftsItems, vecItems)
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

function conversationResultItemFromStore(r: L0SearchResult): ConversationSearchResultItem {
  return {
    id: r.record_id,
    session_key: r.session_key,
    role: r.role,
    content: r.message_text,
    score: r.score,
    recorded_at: r.recorded_at,
  };
}

function filterConversationResults(
  results: ConversationSearchResultItem[],
  filters: {
    sessionFilter?: string;
    sessionPrefixes: string[];
    logger?: Logger;
  },
): ConversationSearchResultItem[] {
  const { sessionFilter, sessionPrefixes, logger } = filters;
  let filtered = results;
  if (sessionFilter) {
    const preFilterCount = filtered.length;
    filtered = filtered.filter((r) => r.session_key === sessionFilter);
    logger?.debug?.(`${TAG} After session filter "${sessionFilter}": ${filtered.length}/${preFilterCount}`);
  }
  if (sessionPrefixes.length > 0) {
    const preFilterCount = filtered.length;
    filtered = filtered.filter((r) =>
      sessionPrefixes.some((prefix) => r.session_key.startsWith(prefix)),
    );
    logger?.debug?.(`${TAG} After session-prefix filter: ${filtered.length}/${preFilterCount}`);
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

export function formatConversationSearchResponse(result: ConversationSearchResult): string {
  if (result.message) {
    return result.message;
  }
  if (result.results.length === 0) {
    return "No matching conversation messages found.";
  }

  const lines: string[] = [
    `Found ${result.total} matching message(s):`,
    "",
  ];

  for (const item of result.results) {
    const scoreStr = typeof item.score === "number" ? ` (score: ${item.score.toFixed(3)})` : "";
    const dateStr = item.recorded_at ? ` [${item.recorded_at}]` : "";
    lines.push(`---`);
    lines.push(`**[${item.role}]** Session: ${item.session_key}${dateStr}${scoreStr}`);
    lines.push("");
    lines.push(item.content);
    lines.push("");
  }

  return lines.join("\n");
}
