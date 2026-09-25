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

import type { IMemoryStore, IsolationFilter, L1SearchResult } from "../store/types.js";
import { hasClientEmbedding, type EmbeddingService } from "../store/embedding.js";
import type { Logger } from "../types.js";
import { recallL1Candidates } from "./l1-candidate-recall.js";

// ============================
// Types
// ============================

export interface MemorySearchResultItem {
  id: string;
  content: string;
  type: string;
  team_id?: string;
  user_id?: string;
  agent_id?: string;
  task_id?: string;
  priority: number;
  scene_name: string;
  score: number;
  version: number;
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

function toSearchItem(r: L1SearchResult): MemorySearchResultItem {
  return {
    id: r.record_id,
    content: r.content,
    type: r.type,
    priority: r.priority,
    scene_name: r.scene_name,
    score: r.score,
    team_id: r.team_id,
    user_id: r.user_id,
    agent_id: r.agent_id,
    task_id: r.task_id,
    version: r.version ?? 0,
    created_at: r.timestamp_start,
    updated_at: r.timestamp_end,
  };
}

function hasNativeL1Hybrid(store: IMemoryStore): boolean {
  return (
    typeof store.getCapabilities === "function" &&
    !!store.getCapabilities().nativeHybridSearch &&
    typeof store.searchL1Hybrid === "function"
  );
}

// ============================
// Search implementation
// ============================

export async function executeMemorySearch(params: {
  query: string;
  limit: number;
  type?: string;
  scene?: string;
  filter?: IsolationFilter;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  logger?: Logger;
}): Promise<MemorySearchResult> {
  const {
    query,
    limit,
    type: typeFilter,
    scene: sceneFilter,
    filter: isolationFilter,
    vectorStore,
    embeddingService,
    logger,
  } = params;

  logger?.debug?.(
    `${TAG} CALLED: query="${query.slice(0, 100)}", limit=${limit}, ` +
    `typeFilter=${typeFilter ?? "(none)"}, sceneFilter=${sceneFilter ?? "(none)"}, ` +
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

  // Native hybrid (TCVDB) is a valid search path even with NoopEmbeddingService.
  const hasEmbedding = hasClientEmbedding(embeddingService);
  const hasFts = vectorStore.isFtsAvailable();
  const nativeHybrid = hasNativeL1Hybrid(vectorStore);

  if (!hasEmbedding && !hasFts && !nativeHybrid) {
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

  const candidateK = limit * 3;
  const recalled = await recallL1Candidates({
    query,
    topK: candidateK,
    vectorStore,
    embeddingService,
    logger,
    filter: isolationFilter,
    logTag: TAG,
  });

  let results = recalled.hits.map(toSearchItem);

  const preFilterCount = results.length;
  if (typeFilter) {
    results = results.filter((r) => r.type === typeFilter);
    logger?.debug?.(`${TAG} After type filter "${typeFilter}": ${results.length}/${preFilterCount}`);
  }
  if (sceneFilter) {
    const normalizedScene = sceneFilter.toLowerCase();
    results = results.filter((r) =>
      r.scene_name.toLowerCase().includes(normalizedScene),
    );
    logger?.debug?.(`${TAG} After scene filter "${sceneFilter}": ${results.length}/${preFilterCount}`);
  }

  const trimmed = results.slice(0, limit);

  logger?.debug?.(
    `${TAG} RESULT (strategy=${recalled.strategy}): returning ${trimmed.length} memories ` +
    `(scores: [${trimmed.map((r) => r.score.toFixed(3)).join(", ")}])`,
  );

  return {
    results: trimmed,
    total: trimmed.length,
    strategy: recalled.strategy,
  };
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
