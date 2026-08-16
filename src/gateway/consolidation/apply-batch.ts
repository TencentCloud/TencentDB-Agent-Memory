/**
 * Apply result → RunBatchResult field mapping.
 *
 * Extracted from runner.ts to keep the runBatch body ≤150 lines. Maps the
 * P4 ApplyResult fields (applied/skipped, reindexed/needsReindex, status)
 * onto the orchestrator's batch result.
 */

import type { ApplyResult } from "../apply-executor.js";
import type { RunBatchResult } from "./runner.js";

export function recordApplyResult(
  result: RunBatchResult,
  applyResult: ApplyResult,
): void {
  result.applied = applyResult.applied;
  result.skipped = applyResult.skipped;
  result.skippedMergesMissingTarget = applyResult.skippedMergesMissingTarget;
  // `?? []` guards the hand-built ApplyResult fakes that bypass the typecheck
  // (role-lock.worker.ts `as never`) — from those the field arrives undefined.
  result.rejected = applyResult.rejected ?? [];
  result.appliedNothing =
    applyResult.applied.merges.length === 0 &&
    applyResult.applied.deletes.length === 0 &&
    applyResult.applied.rewrites.length === 0;
  result.reindexed = applyResult.reindexed;
  result.needsReindex = applyResult.needsReindex;
  result.status = applyResult.ok
    ? "ok"
    : applyResult.status === "aborted"
      ? "aborted"
      : "failed";
  result.partial = applyResult.partial;
  if (applyResult.error) result.error = applyResult.error;
}
