/**
 * Per-batch loop step helper for the night runner.
 *
 * Encapsulates the per-iteration side effects (maxRunMs abort, error
 * propagation, dry-run pass-through, anyApplied update, anchored cursor
 * update, skip-merge detection) so the night-runner.ts loop body stays
 * within ≤150 lines.
 */

import type { RunSummary } from "./types.js";
import type { RunBatchResult } from "./runner-types.js";
import type { L0Cursor } from "./diff-builder.js";

export interface StepResult {
  /** Set `summary.status = "failed"` and break the loop. */
  exit: boolean;
  /** `continue` to the next batch (dry-run path). */
  continueDryRun: boolean;
  anyApplied: boolean;
  /** New anchored cursor (only set on the apply-ok path). */
  anchoredCursor?: L0Cursor | null;
  /** Stop the loop on the FIRST target-missing merge (the night anchor). */
  skipMergeSeen: boolean;
  /** Apply mutated and then aborted in THIS batch (tz-09 Ф2b). */
  partial?: boolean;
}

export function stepBatch(
  summary: RunSummary,
  batchRes: RunBatchResult,
  exceededMaxRunMs: boolean,
): StepResult {
  if (exceededMaxRunMs) {
    summary.status = "failed";
    return {
      exit: true,
      continueDryRun: false,
      anyApplied: false,
      skipMergeSeen: false,
    };
  }
  if (batchRes.error) {
    summary.error = batchRes.error;
    summary.status = (batchRes.status as RunSummary["status"]) ?? "failed";
    return {
      exit: true,
      continueDryRun: false,
      anyApplied: false,
      skipMergeSeen: false,
      partial: batchRes.partial,
    };
  }
  if (batchRes.status === "dry-run") {
    summary.status = "dry-run";
    return {
      exit: false,
      continueDryRun: true,
      anyApplied: false,
      skipMergeSeen: false,
    };
  }
  const anyApplied =
    batchRes.applied.merges.length +
      batchRes.applied.deletes.length +
      batchRes.applied.rewrites.length >
    0;

  if (batchRes.skippedMergesMissingTarget.length > 0) {
    // FIRST target-missing merge anchors the advance: the cursor stops at
    // the last APPLIED chunk BEFORE this one. The loop STOPS here.
    return {
      exit: false,
      continueDryRun: false,
      anyApplied,
      skipMergeSeen: true,
    };
  }
  const anchoredCursor =
    batchRes.status === "ok" ? batchRes.sliceTime : undefined;
  if (batchRes.status !== "ok" && batchRes.status !== "dry-run") {
    summary.status = (batchRes.status as RunSummary["status"]) ?? "failed";
    return {
      exit: true,
      continueDryRun: false,
      anyApplied,
      anchoredCursor,
      skipMergeSeen: false,
    };
  }
  return {
    exit: false,
    continueDryRun: false,
    anyApplied,
    anchoredCursor,
    skipMergeSeen: false,
  };
}
