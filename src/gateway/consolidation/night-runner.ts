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
import { runBatch } from "./runner.js";
import { writeReport } from "./reports.js";
import { advanceCheckpoint, queryRecentRecords } from "./queries.js";
import { collectBlockMeta, countNewL0Since } from "./diff-builder.js";
import { chunkRecords } from "./chunk.js";
import { stepBatch } from "./night-loop-step.js";
import type { OrchestratorContext } from "./context.js";
import type { RunSummary } from "./types.js";
import { mkFailedSummary } from "./summary.js";

export async function executeRunNight(
  ctx: OrchestratorContext,
  opts: { reason: string; dryRun?: boolean; runId: string; role: string },
): Promise<RunSummary> {
  const startedMs = ctx.now();
  const startedAt = new Date(startedMs).toISOString();
  const runScratch = path.join(ctx.scratchRoot, opts.runId);
  const summary: RunSummary = mkFailedSummary(opts.role, startedAt, opts.reason, opts.dryRun);

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

    const night = ctx.config.memory.consolidation.night;
    const allRecords = queryRecentRecords(ctx, cp.l0Cursor, night.diffCap, true);
    const batches = chunkRecords(allRecords, night.diffCap);

    let anyApplied = false;
    let dryRunDiffText: string | undefined;
    let anchoredCursor: string | null = null;
    let skipMergeSeen = false;
    let remainingDeleteCap = night.deleteCapPerRun;
    let remainingRewriteCap = night.rewriteCapPerRun;
    let presentedTotal = 0;

    for (let i = 0; i < batches.length; i++) {
      if (ctx.now() - startedMs > night.maxRunMs) {
        summary.status = "failed";
        summary.error = `night maxRunMs exceeded (${night.maxRunMs}ms) after batch ${i}/${batches.length}`;
        break;
      }
      const batch = batches[i]!;
      const batchScratch = path.join(runScratch, `b${i}`);
      const batchRes = await runBatch(ctx, {
        records: batch,
        overLimit: blocks,
        cp,
        runId: opts.runId,
        role: opts.role,
        dryRun: !!opts.dryRun,
        scratchDir: batchScratch,
        isNight: true,
        remainingDeleteCap,
        remainingRewriteCap,
        startedMs,
      });
      presentedTotal += batchRes.presented;
      summary.applied.merges.push(...batchRes.applied.merges);
      summary.applied.deletes.push(...batchRes.applied.deletes);
      summary.applied.rewrites.push(...batchRes.applied.rewrites);
      summary.skipped.merges.push(...batchRes.skipped.merges);
      summary.skipped.deletes.push(...batchRes.skipped.deletes);
      summary.skipped.rewrites.push(...batchRes.skipped.rewrites);
      summary.reindexed ||= batchRes.reindexed;
      summary.needsReindex ||= batchRes.needsReindex;
      if (batchRes.child) summary.child = batchRes.child;
      if (dryRunDiffText === undefined && batchRes.diffText) {
        dryRunDiffText = batchRes.diffText;
      }
      const step = stepBatch(summary, batchRes, ctx.now() - startedMs > night.maxRunMs);
      if (step.exit) {
        break;
      }
      if (step.continueDryRun) continue;
      anyApplied = anyApplied || step.anyApplied;
      if (step.anchoredCursor !== undefined) anchoredCursor = step.anchoredCursor;
      if (step.skipMergeSeen) break;
      remainingDeleteCap = Math.max(0, remainingDeleteCap - batchRes.deleteOps);
      remainingRewriteCap = Math.max(0, remainingRewriteCap - batchRes.rewriteOps);
    }

    summary.recordsPresented = presentedTotal;

    if (opts.dryRun) {
      summary.status = "dry-run";
      await writeReport(ctx, summary, dryRunDiffText);
      return summary;
    }

    if (anyApplied) {
      // Anchored cursor: max slice-time of applied chunks BEFORE the first
      // skip-merge. null → the anchor is the PREVIOUS cursor (a skip in
      // chunk 1 never advances; the ops re-present next run).
      const anchor = anchoredCursor ?? cp.l0Cursor;
      await advanceCheckpoint(ctx, cp.l0Cursor, newL0, summary, anchor);
    }
    if (summary.error === undefined) summary.status = "ok";

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
    ctx.currentChildRef.value = null;
    if (!opts.dryRun) {
      try {
        await fs.promises.rm(runScratch, { recursive: true, force: true });
      } catch {
        // best-effort scratch cleanup
      }
    }
  }
}
