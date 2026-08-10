/**
 * Day consolidation runner (P6).
 *
 * Single-batch loop: the day keeper sweeps the fresh tail (records with
 * updated_time >= cursor), assembles ONE diff, spawns the keeper, applies.
 * Advance rule: any ok run (including empty/heal-skip) advances the cursor
 * past the fresh tail; a failed/aborted run NEVER advances (idempotent
 * retry re-presents the same diff).
 *
 * Night runs (multi-batch, anchored cursor, cap accumulation) live in
 * night-runner.ts. Shared pipeline (runBatch, writeReport, etc.) lives in
 * runner.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { runBatch } from "./runner.js";
import { writeReport } from "./reports.js";
import { advanceCheckpoint, queryRecentRecords } from "./queries.js";
import { collectBlockMeta, countNewL0Since } from "./diff-builder.js";
import type { OrchestratorContext } from "./context.js";
import type { RunSummary } from "./types.js";
import type { ResolvedRoleContract } from "./role-contract-types.js";
import { mkFailedSummary } from "./summary.js";

export async function executeRunDay(
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
  // Per-role scratch override (forked task-cycle path б): role.json runtime.scratch_root
  // wins over the shared ctx.scratchRoot; legacy roles keep the shared root.
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

    const allRecords = queryRecentRecords(
      ctx,
      cp.l0Cursor,
      opts.contract.batching.diffCap,
      false,
    );

    const batchRes = await runBatch(ctx, {
      records: allRecords,
      overLimit: blocks,
      cp,
      runId: opts.runId,
      role: opts.role,
      dryRun: !!opts.dryRun,
      scratchDir: runScratch,
      contract: opts.contract,
      remainingDeleteCap: 0,
      remainingRewriteCap: 0,
      startedMs,
    });
    summary.recordsPresented = batchRes.presented;
    summary.applied = { ...batchRes.applied };
    summary.skipped = { ...batchRes.skipped };
    summary.reindexed = batchRes.reindexed;
    summary.needsReindex = batchRes.needsReindex;
    if (batchRes.child) summary.child = batchRes.child;

    if (opts.dryRun) {
      summary.status = "dry-run";
      await writeReport(ctx, summary, batchRes.diffText);
      return summary;
    }

    if (batchRes.error) {
      summary.error = batchRes.error;
      summary.status = (batchRes.status as RunSummary["status"]) ?? "failed";
    } else if (!batchRes.appliedNothing) {
      // anyApplied: advance unconditionally (idempotent retry re-presents
      // the same diff, but the cursor moves past the fresh tail).
      summary.status = "ok";
      await advanceCheckpoint(ctx, cp.l0Cursor, newL0, summary, undefined);
    } else if (summary.error === undefined) {
      // empty/heal-skip: day still advances past the fresh tail.
      summary.status = "ok";
      await advanceCheckpoint(ctx, cp.l0Cursor, newL0, summary, undefined);
    }

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
