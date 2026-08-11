/**
 * Scope predicate and per-type rerank.
 *
 * - `passesScope` — single source of truth for project-scoped visibility.
 *   Mirrored verbatim by the SQL filter in `sqlite.ts`.
 * - `applyTypeWeights` — multiply each item's score by its type weight
 *   BEFORE top-K selection (ТЗ §5.15). All weights 1.0 = feature off.
 * - `searchMemoriesWithDetails` — thin wrapper around `searchMemories` that
 *   also extracts structured `RecalledMemory` from formatted lines for
 *   metric reporting.
 */

import { searchMemories } from "./search.js";
import type { RecallStrategy, RecalledMemory, SearchTiming, TypeWeights } from "./types.js";
import type { MemoryTdaiConfig } from "../../../config.js";
import type { EmbeddingService } from "../../store/embedding.js";
import type { IMemoryStore } from "../../store/types.js";
import type { Logger } from "../../types.js";

/**
 * How project visibility is decided, and the single knob that travels from the
 * config to every store call (tz-05 Ф4):
 *
 * - `hidden` — today's behaviour: a record only hides when it is explicitly
 *   tagged to a DIFFERENT project. Unset scope passes as global. This is the
 *   rollback path (ТЗ tz-05 :147) and stays the default until the scope
 *   migration has actually run.
 * - `strict` — the same, except an unset scope no longer passes for global.
 * - `decay` — no filtering at all; cross-project records are downweighted
 *   later by `scope-decay.ts`. This is the deployed mode.
 *
 * Three implementations must agree: this function, the SQL predicate in
 * `sqlite.ts`, and the TCVDB filter expression.
 */
export type ScopeMode = "hidden" | "decay" | "strict";

/**
 * Single source of truth for project-scoped visibility. Mirrored verbatim
 * by the SQL filter in `sqlite.ts` — the two must stay literally equivalent.
 * Only records explicitly tagged to a *different* project are hidden.
 *
 * 2-arg form (legacy) = hidden mode. 3-arg mode-aware: in `decay` mode the
 * strict project_id equality is skipped — cross-project records survive
 * and are downweighted further down the pipeline (scope-decay.ts).
 */
export function passesScope(
  r: { scope?: string; project_id?: string },
  projectId?: string,
  mode: ScopeMode = "hidden",
): boolean {
  if (mode === "decay") return true;       // multiplier handles it downstream
  if (!projectId) return true;            // filter disabled
  if (mode === "strict") {
    // A record must SAY it is global to be treated as global. Unset scope is
    // unknown provenance, not permission (tz-05 критерий 5).
    return r.scope === "global" || (r.scope === "project" && r.project_id === projectId);
  }
  if (r.scope !== "project") return true; // global / unset / legacy
  return r.project_id === projectId;
}

/**
 * Per-type recall rerank (improvement #2). Multiplies each item's score by
 * the weight of its type BEFORE top-K selection, so `instruction`/`persona`
 * records can outrank `episodic` ones for the same cosine/query match.
 * All weights 1.0 (config default) = feature off — the returned array is
 * unchanged.
 */
export function applyTypeWeights<T extends { score: number; type?: string }>(
  items: T[],
  weights: TypeWeights,
): T[] {
  if (!weights) return items;
  if (weights.instruction === 1 && weights.persona === 1 && weights.episodic === 1) return items;
  const weightOf = (type: string | undefined): number => {
    if (type === "instruction") return weights.instruction;
    if (type === "persona") return weights.persona;
    if (type === "episodic") return weights.episodic;
    return 1;
  };
  return items
    .map((item) => ({ item, weighted: item.score * weightOf(item.type) }))
    .sort((a, b) => b.weighted - a.weighted)
    .map((x) => x.item);
}

/**
 * Search memories and return both formatted lines and structured details.
 * This is a thin wrapper around `searchMemories` that also captures the
 * recalled memory metadata for metric reporting. It parses the returned
 * formatted lines to extract type/content info. Exported so the gateway
 * recall-quality probe (P10) can measure the real recall pipeline
 * (strategy + typeWeights) end-to-end.
 */
export async function searchMemoriesWithDetails(
  userText: string,
  pluginDataDir: string,
  cfg: MemoryTdaiConfig,
  logger: Logger | undefined,
  strategy: RecallStrategy,
  vectorStore?: IMemoryStore,
  embeddingService?: EmbeddingService,
  projectId = "",
): Promise<{ lines: string[]; memories: RecalledMemory[]; timing: SearchTiming }> {
  const result = await searchMemories(userText, pluginDataDir, cfg, logger, strategy, vectorStore, embeddingService, projectId);
  const memories: RecalledMemory[] = result.lines.map((line) => {
    const match = line.match(/^-\s+\[([^\]]+)\]\s+(.+?)(?:\s*\(活动时间:.*\))?$/);
    if (match) {
      const tag = match[1];
      const content = match[2].trim();
      const typePart = tag.includes("|") ? tag.split("|")[0] : tag;
      return { content, score: 0, type: typePart };
    }
    return { content: line, score: 0, type: "unknown" };
  });
  return { lines: result.lines, memories, timing: result.timing };
}
