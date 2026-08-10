/**
 * Batching strategy `fresh-tail-single-batch` (tz-01 B2) — what the day
 * keeper used to be, now selected by the contract instead of by the role
 * name. Sweeps the fresh tail (records with updated_time >= cursor) into ONE
 * diff, spawns the role, applies.
 *
 * Advance rule: any ok run (including empty/heal-skip) advances the cursor
 * past the fresh tail; a failed/aborted run NEVER advances (an idempotent
 * retry re-presents the same diff).
 */
import { runBatch } from "./runner.js";
import { queryRecentRecords } from "./queries.js";
import type { StrategyInput, StrategyOutcome } from "./run-strategy-types.js";
import type { RunSummary } from "./types.js";

export async function runFreshTailSingleBatch(
  input: StrategyInput,
): Promise<StrategyOutcome> {
  const { ctx, opts, summary, cp } = input;
  const allRecords = queryRecentRecords(
    ctx,
    cp.l0Cursor,
    opts.contract.batching.diffCap,
    false,
  );

  const batchRes = await runBatch(ctx, {
    records: allRecords,
    overLimit: input.blocks,
    cp,
    runId: opts.runId,
    role: opts.role,
    dryRun: !!opts.dryRun,
    scratchDir: input.runScratch,
    contract: opts.contract,
    remainingDeleteCap: 0,
    remainingRewriteCap: 0,
    startedMs: input.startedMs,
  });
  summary.recordsPresented = batchRes.presented;
  summary.applied = { ...batchRes.applied };
  summary.skipped = { ...batchRes.skipped };
  summary.reindexed = batchRes.reindexed;
  summary.needsReindex = batchRes.needsReindex;
  if (batchRes.child) summary.child = batchRes.child;

  if (batchRes.error) {
    summary.error = batchRes.error;
    summary.status = (batchRes.status as RunSummary["status"]) ?? "failed";
    return { diffText: batchRes.diffText, partial: batchRes.partial };
  }
  // Applied or empty/heal-skip — both advance past the fresh tail.
  if (summary.error === undefined) summary.status = "ok";
  return { diffText: batchRes.diffText, advance: { anchor: undefined } };
}
