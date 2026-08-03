/** Strategy: Keyword (FTS5 BM25, no in-memory fallback to avoid O(N) full scan). */

import { buildFtsQuery } from "../../store/sqlite.js";
import type { IMemoryStore } from "../../store/types.js";
import type { Logger } from "../../types.js";
import { TAG } from "./types.js";
import { passesScope } from "./scope.js";
import { ftsResultToFormatable, formatMemoryLine } from "./format.js";

export async function searchByKeyword(
  userText: string,
  _pluginDataDir: string,
  maxResults: number,
  threshold: number,
  logger?: Logger,
  vectorStore?: IMemoryStore,
  projectId = "",
): Promise<string[]> {
  if (vectorStore?.isFtsAvailable()) {
    const ftsQuery = buildFtsQuery(userText);
    if (ftsQuery) {
      logger?.debug?.(`${TAG} [keyword-fts] Using FTS5 BM25 search: query="${ftsQuery}"`);
      const ftsResults = (await vectorStore.searchL1Fts(ftsQuery, maxResults * 2, projectId))
        .filter((r) => passesScope(r, projectId));
      if (ftsResults.length > 0) {
        logger?.debug?.(
          `${TAG} [keyword-fts] FTS5 raw results (${ftsResults.length}): ` +
          ftsResults.map((r) => `id=${r.record_id} score=${r.score.toFixed(6)}`).join(", "),
        );
        const filtered = ftsResults.filter((r) => r.score >= threshold).slice(0, maxResults);
        if (filtered.length > 0) {
          logger?.debug?.(`${TAG} [keyword-fts] FTS5 found ${filtered.length} results (from ${ftsResults.length} raw, threshold=${threshold})`);
          return filtered.map((r) => formatMemoryLine(ftsResultToFormatable(r)));
        }
        // BM25 absolute scores are unreliable with very small document sets.
        if (ftsResults.length <= maxResults) {
          logger?.debug?.(`${TAG} [keyword-fts] All ${ftsResults.length} results below threshold=${threshold} but document set is small — returning all matched results`);
          return ftsResults.slice(0, maxResults).map((r) => formatMemoryLine(ftsResultToFormatable(r)));
        }
        logger?.debug?.(`${TAG} [keyword-fts] FTS5 returned 0 results above threshold (from ${ftsResults.length} raw)`);
      }
    }
  }
  logger?.debug?.(`${TAG} [keyword] FTS5 unavailable or no results, skipping keyword search`);
  return [];
}
