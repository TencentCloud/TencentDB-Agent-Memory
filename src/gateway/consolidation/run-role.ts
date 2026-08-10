/**
 * The single role run (tz-01 B2): everything that does not depend on the
 * batching strategy lives here, and the strategy is chosen by the CONTRACT
 * (`batching.strategy`) — the role name is never compared against a literal.
 *
 * Shared shell: scratch dir, checkpoint read, newL0, over-limit blocks,
 * dry-run branch, checkpoint advance, report, scratch cleanup.
 */
import fs from "node:fs";
import path from "node:path";
import { writeReport } from "./reports.js";
import { advanceCheckpoint, stampRoleRun } from "./queries.js";
import { collectBlockMeta, countNewL0Since } from "./diff-builder.js";
import { mkFailedSummary } from "./summary.js";
import { runFreshTailSingleBatch } from "./run-strategy-fresh-tail.js";
import { runBoundedFullStoreChunked } from "./run-strategy-chunked.js";
import type { OrchestratorContext } from "./context.js";
import type { RunSummary } from "./types.js";
import type { RunRoleOpts, StrategyInput } from "./run-strategy-types.js";

export type { RunRoleOpts };

export async function runRole(
  ctx: OrchestratorContext,
  opts: RunRoleOpts,
): Promise<RunSummary> {
  const startedMs = ctx.now();
  const startedAt = new Date(startedMs).toISOString();
  // Per-role scratch override (forked task-cycle path б): the contract's
  // runtime.scratch_root wins over the shared ctx.scratchRoot; a legacy role
  // without one keeps the shared root.
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

    const input: StrategyInput = {
      ctx,
      opts,
      runScratch,
      cp,
      blocks,
      summary,
      startedMs,
    };
    const outcome =
      opts.contract.batching.strategy === "bounded-full-store-chunked"
        ? await runBoundedFullStoreChunked(input)
        : await runFreshTailSingleBatch(input);

    if (opts.dryRun) {
      summary.status = "dry-run";
      await writeReport(ctx, summary, outcome.diffText);
      return summary;
    }
    if (outcome.advance) {
      await advanceCheckpoint(
        ctx,
        cp.l0Cursor,
        newL0,
        summary,
        outcome.advance.anchor,
      );
    } else {
      // A successful run that moved no cursor still counts as "ran today",
      // otherwise a scheduled no-op repeats every tick. A FAILED run does not
      // touch lastRunAt — it stays retryable — but its failure IS counted, and
      // that count is what bounds the retries (contract retry_budget).
      await stampRoleRun(ctx, summary);
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
