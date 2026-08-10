/**
 * Batching strategy `bounded-full-store-chunked` (tz-01 B2) — what the night
 * keeper used to be, now selected by the contract instead of by the role
 * name. Slices the WHOLE store (bounded by NIGHT_SWEEP_LIMIT) into per-batch
 * diffs.
 *
 * The first target-missing merge anchors the advance (the cursor stops at the
 * last applied chunk BEFORE the skip; later chunks re-present next run). Cap
 * accumulation: the per-run delete/rewrite caps are split across batches
 * (residual budget, not 2×cap).
 */
import { queryRecentRecords } from "./queries.js";
import { chunkRecords } from "./chunk.js";
import { runNightBatches } from "./night-batches.js";
import type { StrategyInput, StrategyOutcome } from "./run-strategy-types.js";

export async function runBoundedFullStoreChunked(
  input: StrategyInput,
): Promise<StrategyOutcome> {
  const { ctx, opts, summary, cp } = input;
  const diffCap = opts.contract.batching.diffCap;
  const allRecords = queryRecentRecords(ctx, cp.l0Cursor, diffCap, true);
  const batches = chunkRecords(allRecords, diffCap);

  const res = await runNightBatches(ctx, {
    reason: opts.reason,
    dryRun: opts.dryRun,
    runId: opts.runId,
    role: opts.role,
    contract: opts.contract,
    runScratch: input.runScratch,
    batches,
    blocks: input.blocks,
    cp,
    summary,
    startedMs: input.startedMs,
  });

  summary.recordsPresented = res.presentedTotal;
  if (summary.error === undefined) summary.status = "ok";
  if (!res.anyApplied) return { diffText: res.dryRunDiffText };
  // Anchored cursor: max slice-time of the applied chunks BEFORE the first
  // skip-merge. null → the anchor is the PREVIOUS cursor (a skip in chunk 1
  // never advances; the ops re-present next run).
  return {
    diffText: res.dryRunDiffText,
    advance: { anchor: res.anchoredCursor ?? cp.l0Cursor },
  };
}
