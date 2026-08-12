/**
 * Scope predicate and per-type rerank.
 *
 * - `passesScope` — single source of truth for project-scoped visibility.
 *   Mirrored verbatim by the SQL filter in `sqlite.ts`.
 * - `applyTypeWeights` — multiply each item's score by its type weight
 *   BEFORE top-K selection (ТЗ §5.15). All weights 1.0 = feature off.
 * - `filterByScope` — the same predicate applied to a candidate list, with a
 *   diagnostic per rejected row (tz-10 C10.5).
 * - `searchMemoriesWithDetails` — thin wrapper around `searchMemories` that
 *   surfaces the structured items for metric reporting.
 */

import { searchMemories } from "./search.js";
import type {
  RecallDiagnostic,
  RecallItem,
  RecallStrategy,
  RecalledMemory,
  SearchTiming,
  TypeWeights,
} from "./types.js";
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
  if (mode === "decay") return true; // multiplier handles it downstream
  if (!projectId) return true; // filter disabled
  if (mode === "strict") {
    // A record must SAY it is global to be treated as global. Unset scope is
    // unknown provenance, not permission (tz-05 критерий 5).
    return (
      r.scope === "global" ||
      (r.scope === "project" && r.project_id === projectId)
    );
  }
  if (r.scope !== "project") return true; // global / unset / legacy
  return r.project_id === projectId;
}

/**
 * Drop the candidates `passesScope` refuses, recording one diagnostic per
 * drop. An exclusion without a reason is exactly what the invariant
 * `project-recall-measurable` (tz-10) forbids: leakage that nobody can count
 * looks the same as no leakage at all.
 */
export function filterByScope<
  T extends { record_id: string; scope?: string; project_id?: string },
>(
  candidates: T[],
  projectId: string,
  mode: ScopeMode,
  diagnostics: RecallDiagnostic[],
): T[] {
  const kept: T[] = [];
  for (const r of candidates) {
    if (passesScope(r, projectId, mode)) {
      kept.push(r);
      continue;
    }
    diagnostics.push({
      stage: "scope",
      code: "scope-filtered",
      message:
        `scope=${r.scope ?? "(unset)"} project=${r.project_id ?? "(unset)"} ` +
        `rejected by mode=${mode} for project=${projectId || "(none)"}`,
      itemId: r.record_id,
    });
  }
  return kept;
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
  if (
    weights.instruction === 1 &&
    weights.persona === 1 &&
    weights.episodic === 1
  )
    return items;
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
 * Search memories and return the structured items alongside their rendered
 * lines. Exported so the gateway recall-quality probe (P10) can measure the
 * real recall pipeline (strategy + typeWeights) end-to-end.
 *
 * Until tz-10a this wrapper re-parsed its own rendered lines with a regex and
 * handed every caller `score: 0` and no record id. The items now come from
 * the strategy that found them, so `RecalledMemory.score` is the real final
 * score (tz-10 C10.3).
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
): Promise<{
  lines: string[];
  items: RecallItem[];
  memories: RecalledMemory[];
  timing: SearchTiming;
  diagnostics: RecallDiagnostic[];
}> {
  const result = await searchMemories(
    userText,
    pluginDataDir,
    cfg,
    logger,
    strategy,
    vectorStore,
    embeddingService,
    projectId,
  );
  return {
    lines: result.lines,
    items: result.items,
    memories: result.items.map(itemToRecalledMemory),
    timing: result.timing,
    diagnostics: result.diagnostics,
  };
}

/** Legacy metric shape (`RecalledMemory`) projected from a structured item. */
export function itemToRecalledMemory(item: RecallItem): RecalledMemory {
  return {
    content: item.content,
    score: item.score.final,
    type: item.formatable.type,
  };
}
