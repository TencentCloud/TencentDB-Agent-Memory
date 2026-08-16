/**
 * Result + intermediate types for ApplyExecutor (wave tdai-memory-subagents-2026-08-02, P4).
 *
 * ApplyResult is the public report contract: HTTP layer maps status +
 * statusCode to the response code; reindex scene keeps the same shape.
 */

import type { ApplyOp, ApplyDiff } from "./schemas.js";
import type { ApplyExecutorDeps } from "./apply-executor-deps.js";

// Re-export so external callers can import ApplyOp/ApplyDiff from one place
// (matches the public surface the orchestrator / role-files use).
export type { ApplyOp, ApplyDiff };

// Re-export ApplyExecutorDeps from its dedicated file (keep types.ts free of
// runtime imports like IMemoryStore / EmbeddingService — those live in
// apply-executor-deps.ts so this file stays a pure data-shape module).
export type { ApplyExecutorDeps };

/**
 * One operation the apply refused, with the reason.
 *
 * Refusal is PER-OPERATION: the diff loses the operation, not the batch. Run
 * f947be67 (night-keeper, 2026-08-14) lost 362 presented records and 16
 * minutes of model work because a literal `null` in the optional
 * `rewritePersona` failed the whole request — a blast radius the guardrails
 * never needed. Every guardrail is stated per-op ("the child may only touch
 * what it was shown"), so refusing the op alone keeps the guarantee whole.
 */
export interface RejectedOp {
  /** Diff section the op came from ("merge", "rewritePersona", …) — or an
   * unknown key exactly as the role sent it. */
  section: string;
  /** Which op: record id / path, or "#<index>" when the element is malformed
   * past having a name. */
  ref: string;
  reason: string;
}

export interface ApplyCounts {
  metaCount: number | null;
  vecCount: number | null;
  /** null when vec0 tables are absent / the check was skipped. */
  consistent: boolean | null;
}

export interface ApplyResult {
  ok: boolean;
  status: "applied" | "aborted" | "failed";
  /** True when ≥ 1 mutation was applied before an abort (heal re-run needed). */
  partial: boolean;
  /** True once a write has REACHED the store, even if the operation that owns
   * it never completed. A merge whose target was rewritten and whose member
   * deletion then threw never reaches `applied`, so judging "did this apply
   * mutate?" by the applied lists alone calls a half-written store a clean
   * failure. It is not clean, and only reconciliation can say how far it got
   * (tz-09 S4 :135). A call that reported failure WITHOUT writing (deleteL1Batch
   * returning false, writeMemory returning null) does not set it: nothing
   * reached the store, and there is nothing to reconcile. */
  storeTouched: boolean;
  /** HTTP status for aborted/failed results (400 validation · 409 drift/stale · 500 runtime). */
  statusCode?: number;
  error?: string;
  applied: { merges: string[]; deletes: string[]; rewrites: string[] };
  skipped: { merges: string[]; deletes: string[]; rewrites: string[] };
  /** Merge ops skipped because the TARGET is missing (cross-batch partner
   * deleted earlier) — distinct from heal-skip (target alive, members gone).
   * The night loop anchors its cursor on the FIRST such skip (plan #9). */
  skippedMergesMissingTarget: string[];
  /** Ops refused one by one, with reasons (@see RejectedOp). Non-empty with
   * `status: "applied"` means the rest of the diff went through. */
  rejected: RejectedOp[];
  counts: ApplyCounts | null;
  reindexed: boolean;
  needsReindex: boolean;
  sceneIndexSynced: boolean;
}

/** Diff payload after zod parse + structural validation. */
export interface ParsedApplyRequest {
  diff: {
    deleteL1?: Array<{ id: string; updatedAt: string }>;
    merge?: Array<{ cluster: string[]; target: string; content: string }>;
    rewriteBlock?: Array<{ path: string; content: string }>;
    rewriteRecord?: Array<{ id: string; updatedAt: string; content: string }>;
    rewritePersona?: string;
  };
  manifest: { baseline: Record<string, string> };
  context: { presentedRecordIds: string[] };
}

/** Row fetched for merge provenance / stale re-check. */
export interface MetaRow {
  record_id: string;
  updated_time: string;
  /** Original creation time — preserved on rewriteRecord/merge via createdAtOverride. */
  created_time: string;
  /** Current content — heal-skip (rewrite already applied) compares against it. */
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  session_key: string;
  session_id: string;
  project_id: string;
  scope: string;
  metadata_json: string;
}

/** Initial empty ApplyResult for the happy/abort path mutation accumulator. */
export const EMPTY_RESULT = (): ApplyResult => ({
  ok: false,
  status: "aborted",
  partial: false,
  storeTouched: false,
  applied: { merges: [], deletes: [], rewrites: [] },
  skipped: { merges: [], deletes: [], rewrites: [] },
  skippedMergesMissingTarget: [],
  rejected: [],
  counts: null,
  reindexed: false,
  needsReindex: false,
  sceneIndexSynced: false,
});
