/**
 * Shared run-batch pipeline for the consolidation orchestrator.
 *
 * runBatch: thin wrapper that calls preApply (diff build → spawn → parse
 * → caps check) then ctx.applyDiff and records the result. The heavy
 * stages live in runner-stages.ts to keep this file ≤150 lines.
 *
 * Both batching strategies call this with the resolved role contract and
 * their remaining cap budgets.
 */

import { manifestShaMap } from "./diff-builder.js";
import { preApply } from "./runner-stages.js";
import { recordApplyResult } from "./apply-batch.js";
import type { OrchestratorContext } from "./context.js";
import type { RunBatchArgs, RunBatchResult } from "./runner-types.js";

export type { RunBatchArgs, RunBatchResult };

function emptyResult(): RunBatchResult {
  return {
    presented: 0,
    sliceTime: null,
    applied: { merges: [], deletes: [], rewrites: [] },
    skipped: { merges: [], deletes: [], rewrites: [] },
    skippedMergesMissingTarget: [],
    appliedNothing: true,
    deleteOps: 0,
    rewriteOps: 0,
    reindexed: false,
    needsReindex: false,
  };
}

export async function runBatch(
  ctx: OrchestratorContext,
  args: RunBatchArgs,
): Promise<RunBatchResult> {
  const result = emptyResult();
  try {
    const pre = await preApply(ctx, args, result);
    if (!pre.ok || !pre.baseline || pre.rawDiff === undefined) return result;

    const applyResult = await ctx.applyDiff({
      diff: pre.rawDiff,
      manifest: { baseline: manifestShaMap(pre.baseline) },
      context: { presentedRecordIds: pre.presentedRecordIds ?? [] },
    });
    recordApplyResult(result, applyResult);
    return result;
  } catch (err) {
    result.error = `unexpected batch error: ${err instanceof Error ? err.message : String(err)}`;
    result.status = "failed";
    return result;
  }
}
