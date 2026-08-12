/** Strategy: Keyword (FTS5 BM25, no in-memory fallback to avoid O(N) full scan). */

import { buildFtsQuery } from "../../store/sqlite.js";
import type { IMemoryStore, L1FtsResult } from "../../store/types.js";
import type { Logger } from "../../types.js";
import {
  TAG,
  type RecallDiagnostic,
  type RecallItem,
  type StrategyResult,
} from "./types.js";
import { filterByScope } from "./scope.js";
import { scopeDecayMultiplier, type ScopeDecayConfig } from "./scope-decay.js";
import { ftsResultToItem } from "./item.js";
import type { ScopeMode } from "./scope.js";

export async function searchByKeyword(
  userText: string,
  _pluginDataDir: string,
  maxResults: number,
  threshold: number,
  logger?: Logger,
  vectorStore?: IMemoryStore,
  projectId = "",
  scopeDecayCfg?: ScopeDecayConfig,
  mode: ScopeMode = "hidden",
): Promise<StrategyResult> {
  const diagnostics: RecallDiagnostic[] = [];
  if (vectorStore?.isFtsAvailable()) {
    const ftsQuery = buildFtsQuery(userText);
    if (ftsQuery) {
      logger?.debug?.(
        `${TAG} [keyword-fts] Using FTS5 BM25 search: query="${ftsQuery}", mode=${mode}`,
      );
      const candidateK = mode === "decay" ? maxResults * 6 : maxResults * 2;
      const ftsResults = filterByScope(
        await vectorStore.searchL1Fts(ftsQuery, candidateK, projectId, mode),
        projectId,
        mode,
        diagnostics,
      );
      if (ftsResults.length > 0) {
        logger?.debug?.(
          `${TAG} [keyword-fts] FTS5 raw results (${ftsResults.length}): ` +
            ftsResults
              .map((r) => `id=${r.record_id} score=${r.score.toFixed(6)}`)
              .join(", "),
        );
        // Multiplier BEFORE threshold (per critic pipeline-order).
        // Pre-sort by post-multiplier score DESC so slice picks the actual top-K.
        const decayed = ftsResults
          .map((r) => toItem(r, projectId, scopeDecayCfg))
          .sort((a, b) => b.score.final - a.score.final);
        const filtered = decayed
          .filter((i) => i.score.final >= threshold)
          .slice(0, maxResults);
        if (filtered.length > 0) {
          logger?.debug?.(
            `${TAG} [keyword-fts] FTS5 found ${filtered.length} results (from ${ftsResults.length} raw, threshold=${threshold})`,
          );
          return { items: filtered, diagnostics };
        }
        // BM25 absolute scores are unreliable with very small document sets.
        if (ftsResults.length <= maxResults) {
          logger?.debug?.(
            `${TAG} [keyword-fts] All ${ftsResults.length} results below threshold=${threshold} but document set is small — returning all matched results`,
          );
          const rescued = ftsResults
            .slice(0, maxResults)
            .map((r) =>
              toItem(r, projectId, scopeDecayCfg, [
                "below-threshold-small-set",
              ]),
            );
          return { items: rescued, diagnostics };
        }
        logger?.debug?.(
          `${TAG} [keyword-fts] FTS5 returned 0 results above threshold (from ${ftsResults.length} raw)`,
        );
      }
    }
  }
  logger?.debug?.(
    `${TAG} [keyword] FTS5 unavailable or no results, skipping keyword search`,
  );
  return { items: [], diagnostics };
}

/** One FTS row → item, with the decay multiplier recorded as a score reason. */
function toItem(
  r: L1FtsResult,
  projectId: string,
  scopeDecayCfg: ScopeDecayConfig | undefined,
  extraReasons: string[] = [],
): RecallItem {
  const multiplier = scopeDecayMultiplier(r, projectId, scopeDecayCfg);
  return ftsResultToItem(r, {
    raw: r.score,
    final: r.score * multiplier,
    reasons: ["fts-bm25", `decay:${multiplier}`, ...extraReasons],
  });
}
