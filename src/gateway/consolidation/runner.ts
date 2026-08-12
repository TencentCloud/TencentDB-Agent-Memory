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
import { runCriticStage, digestOf } from "./critic-stage.js";
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

    // tz-09 Ф4b: the critic decides BEFORE apply. Fail-closed in enforce —
    // no verdict is a refusal, never a default-approve.
    const review = await runCriticStage(ctx, {
      runId: args.runId,
      scratchDir: args.scratchDir,
      role: args.contract,
      candidate: pre.rawDiff,
      inputDigest: digestOf(result.diffText ?? ""),
    });
    if (!review.ok) {
      result.error = `critic gate refused apply: ${review.reason ?? "no verdict"}`;
      result.status = "failed";
      return result;
    }

    const applyResult = await ctx.applyDiff(
      {
        diff: pre.rawDiff,
        manifest: { baseline: manifestShaMap(pre.baseline) },
        context: { presentedRecordIds: pre.presentedRecordIds ?? [] },
      },
      // tz-09 Ф3: what this run may do comes from the CONTRACT, alongside the
      // body — never inside it.
      {
        runId: args.runId,
        // Half of every operationId (Ф5): the journal is bound to THIS
        // candidate, so a replay of a different one cannot collide with it.
        candidateDigest: digestOf(pre.rawDiff),
        opsSubset: args.contract.policy.opsSubset,
        caps: args.contract.policy.caps,
        gateMode: ctx.applyGateMode,
        // The run is closed by finalizeRunOutcome when the WHOLE run ends —
        // not by the first batch that applies (night-batches.ts runs several).
        closesRun: false,
      },
    );
    recordApplyResult(result, applyResult);
    return result;
  } catch (err) {
    result.error = `unexpected batch error: ${err instanceof Error ? err.message : String(err)}`;
    result.status = "failed";
    return result;
  }
}
