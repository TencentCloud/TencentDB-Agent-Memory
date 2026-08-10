/**
 * Night consolidation runner (P6).
 *
 * Multi-batch loop: slice the WHOLE store into per-batch diffs. The first
 * target-missing merge anchors the advance (cursor stops at the last
 * applied chunk BEFORE the skip; later chunks re-present next run). Cap
 * accumulation: per-run deleteCapPerRun / rewriteCapPerRun are split across
 * batches (residual budget, not 2×cap).
 *
 * Day runs (single batch, day advance) live in day-runner.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { writeReport } from "./reports.js";
import { advanceCheckpoint, queryRecentRecords } from "./queries.js";
import { collectBlockMeta, countNewL0Since } from "./diff-builder.js";
import { chunkRecords } from "./chunk.js";
import { runNightBatches } from "./night-batches.js";
import type { OrchestratorContext } from "./context.js";
import type { RunSummary } from "./types.js";
import type { ResolvedRoleContract } from "./role-contract-types.js";
import { mkFailedSummary } from "./summary.js";

export async function executeRunNight(
  ctx: OrchestratorContext,
  opts: {
    reason: string;
    dryRun?: boolean;
    runId: string;
    role: string;
    contract: ResolvedRoleContract;
  },
): Promise<RunSummary> {
  const startedMs = ctx.now();
  const startedAt = new Date(startedMs).toISOString();
  // Per-role scratch override (forked task-cycle path б): night-keeper's
  // runtime.scratch_root routes the sub-session cwd into its own runs dir
  // instead of the shared orchestrator scratchRoot.
  const scratchRoot = opts.contract.assets.scratchRoot ?? ctx.scratchRoot;
  const runScratch = path.join(scratchRoot, opts.runId);
  const summary: RunSummary = mkFailedSummary(
    opts.role,
    startedAt,
    opts.reason,
    opts.dryRun,
  );

  try {
    const cp = (await ctx.checkpoint.read()) as {
      l0Cursor: string;
      lastRunAt: string | null;
    };
    const dbPath = path.join(ctx.dataDir, "vectors.db");
    const newL0 = countNewL0Since(dbPath, cp.l0Cursor) ?? 0;
    summary.newL0 = newL0;

    const blocks = collectBlockMeta(ctx.dataDir);
    summary.overLimitBlocks = blocks.filter((b) => b.size > b.limit).length;

    const diffCap = opts.contract.batching.diffCap;
    const allRecords = queryRecentRecords(ctx, cp.l0Cursor, diffCap, true);
    const batches = chunkRecords(allRecords, diffCap);

    const res = await runNightBatches(ctx, {
      reason: opts.reason,
      dryRun: opts.dryRun,
      runId: opts.runId,
      role: opts.role,
      contract: opts.contract,
      runScratch,
      batches,
      blocks,
      cp,
      summary,
      startedMs,
    });

    summary.recordsPresented = res.presentedTotal;

    if (opts.dryRun) {
      summary.status = "dry-run";
      await writeReport(ctx, summary, res.dryRunDiffText);
      return summary;
    }

    if (res.anyApplied) {
      // Anchored cursor: max slice-time of applied chunks BEFORE the first
      // skip-merge. null → the anchor is the PREVIOUS cursor (a skip in
      // chunk 1 never advances; the ops re-present next run).
      const anchor = res.anchoredCursor ?? cp.l0Cursor;
      if (summary.error === undefined) summary.status = "ok";
      await advanceCheckpoint(ctx, cp.l0Cursor, newL0, summary, anchor);
    }
    if (summary.error === undefined && !res.anyApplied) summary.status = "ok";

    await writeReport(ctx, summary);
    return summary;
  } catch (err) {
    summary.error = `unexpected run error: ${err instanceof Error ? err.message : String(err)}`;
    summary.finishedAt = new Date(ctx.now()).toISOString();
    summary.elapsedMs = ctx.now() - startedMs;
    try {
      await writeReport(ctx, summary);
    } catch {
      // best-effort
    }
    return summary;
  } finally {
    ctx.childrenRef.value.delete(opts.runId);
    if (!opts.dryRun) {
      try {
        await fs.promises.rm(runScratch, { recursive: true, force: true });
      } catch {
        // best-effort scratch cleanup
      }
    }
  }
}
