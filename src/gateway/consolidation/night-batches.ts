/**
 * Night batch loop (P6): iterate chunked records, run each batch, fold
 * results into the summary, stop on maxRunMs / skip-merge anchor / cap
 * exhaustion. Split from night-runner.ts to keep that file ≤150 lines.
 */
import path from "node:path";
import { runBatch } from "./runner.js";
import { stepBatch } from "./night-loop-step.js";
import type { BlockMeta, RecordEntry } from "./diff-builder.js";
import type { OrchestratorContext } from "./context.js";
import type { RunSummary } from "./types.js";
import type { ResolvedRoleContract } from "./role-contract-types.js";

export interface NightBatchResult {
  anyApplied: boolean;
  dryRunDiffText: string | undefined;
  anchoredCursor: string | null;
  skipMergeSeen: boolean;
  presentedTotal: number;
  remainingDeleteCap: number;
  remainingRewriteCap: number;
}

export async function runNightBatches(
  ctx: OrchestratorContext,
  opts: {
    reason: string;
    dryRun?: boolean;
    runId: string;
    role: string;
    contract: ResolvedRoleContract;
    runScratch: string;
    batches: RecordEntry[][];
    blocks: BlockMeta[];
    cp: { l0Cursor: string; lastRunAt: string | null };
    summary: RunSummary;
    startedMs: number;
  },
): Promise<NightBatchResult> {
  // Per-run budgets and the overall window come from the role contract
  // (tz-01 `contract-drives-execution`), not from the global night config.
  const { caps, maxRunMs } = opts.contract.policy;
  let anyApplied = false;
  let dryRunDiffText: string | undefined;
  let anchoredCursor: string | null = null;
  let skipMergeSeen = false;
  let remainingDeleteCap = caps.deletePerRun;
  let remainingRewriteCap = caps.rewritePerRun;
  let presentedTotal = 0;

  for (let i = 0; i < opts.batches.length; i++) {
    if (ctx.now() - opts.startedMs > maxRunMs) {
      opts.summary.status = "failed";
      opts.summary.error = `max_run_ms exceeded (${maxRunMs}ms) after batch ${i}/${opts.batches.length}`;
      break;
    }
    const batch = opts.batches[i]!;
    const batchScratch = path.join(opts.runScratch, `b${i}`);
    const batchRes = await runBatch(ctx, {
      records: batch,
      overLimit: opts.blocks,
      cp: opts.cp,
      runId: opts.runId,
      role: opts.role,
      dryRun: !!opts.dryRun,
      scratchDir: batchScratch,
      contract: opts.contract,
      remainingDeleteCap,
      remainingRewriteCap,
      startedMs: opts.startedMs,
    });
    presentedTotal += batchRes.presented;
    opts.summary.applied.merges.push(...batchRes.applied.merges);
    opts.summary.applied.deletes.push(...batchRes.applied.deletes);
    opts.summary.applied.rewrites.push(...batchRes.applied.rewrites);
    opts.summary.skipped.merges.push(...batchRes.skipped.merges);
    opts.summary.skipped.deletes.push(...batchRes.skipped.deletes);
    opts.summary.skipped.rewrites.push(...batchRes.skipped.rewrites);
    opts.summary.reindexed ||= batchRes.reindexed;
    opts.summary.needsReindex ||= batchRes.needsReindex;
    if (batchRes.child) opts.summary.child = batchRes.child;
    if (dryRunDiffText === undefined && batchRes.diffText) {
      dryRunDiffText = batchRes.diffText;
    }
    const step = stepBatch(
      opts.summary,
      batchRes,
      ctx.now() - opts.startedMs > maxRunMs,
    );
    if (step.exit) break;
    if (step.continueDryRun) continue;
    anyApplied = anyApplied || step.anyApplied;
    if (step.anchoredCursor !== undefined) anchoredCursor = step.anchoredCursor;
    if (step.skipMergeSeen) break;
    remainingDeleteCap = Math.max(0, remainingDeleteCap - batchRes.deleteOps);
    remainingRewriteCap = Math.max(
      0,
      remainingRewriteCap - batchRes.rewriteOps,
    );
  }

  return {
    anyApplied,
    dryRunDiffText,
    anchoredCursor,
    skipMergeSeen,
    presentedTotal,
    remainingDeleteCap,
    remainingRewriteCap,
  };
}
