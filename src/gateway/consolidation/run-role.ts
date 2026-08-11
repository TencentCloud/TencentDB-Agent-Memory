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
import { stampRoleRun } from "./checkpoint-advance.js";
import { finalizeCheckpointAfterRun } from "./checkpoint-gate.js";
import {
  collectBlockMeta,
  countNewL0Since,
  cursorOfCheckpoint,
} from "./diff-builder.js";
import { mkFailedSummary } from "./summary.js";
import { runFreshTailSingleBatch } from "./run-strategy-fresh-tail.js";
import { runBoundedFullStoreChunked } from "./run-strategy-chunked.js";
import { readRun } from "../control-plane/run-repo.js";
import { finalizeRunOutcome } from "./run-outcome.js";
import type { RunPassport } from "../control-plane/run-types.js";
import type { OrchestratorContext } from "./context.js";
import type { RunSummary } from "./types.js";
import type { RunRoleOpts, StrategyInput } from "./run-strategy-types.js";

export type { RunRoleOpts };

/** Write `<scratch>/run.json`. Best-effort: the database row is the truth,
 * this copy only lets a reader tie an artefact to its run. */
function writeRunPassport(
  ctx: OrchestratorContext,
  opts: RunRoleOpts,
  runScratch: string,
): void {
  try {
    const row = readRun(ctx.dataDir, opts.runId);
    if (row === null) return;
    const passport: RunPassport = {
      runId: row.runId,
      fence: row.fence,
      owner: row.leaseOwner ?? "",
      role: row.roleId,
      copyOf: "control-plane.db",
    };
    fs.mkdirSync(runScratch, { recursive: true });
    fs.writeFileSync(
      path.join(runScratch, "run.json"),
      JSON.stringify(passport, null, 2),
      "utf-8",
    );
  } catch (err) {
    ctx.logger.warn?.(
      `[run] passport write failed for ${opts.runId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

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
    // tz-09 Ф1: the run passport — a COPY of the control-plane row that the
    // child's scratch dir carries, so an artefact can be matched back to the
    // run (and, from Ф2, to its fence) without trusting the child.
    if (!opts.dryRun) writeRunPassport(ctx, opts, runScratch);

    const cp = (await ctx.checkpoint.read()) as {
      l0Cursor: string;
      l0CursorId: string;
      lastRunAt: string | null;
    };
    const cursor = cursorOfCheckpoint(cp);
    const dbPath = path.join(ctx.dataDir, "vectors.db");
    const newL0 = countNewL0Since(dbPath, cursor) ?? 0;
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
    // tz-09 Ф2b: the failure CLASS decides what happens next, and it is
    // written where the next dispatch can see it — not just into the report.
    // tz-03a: this now runs BEFORE the checkpoint, because the checkpoint gate
    // asks the control plane whether the apply completed. In the old order the
    // cursor moved first and the run's state was written afterwards, so the
    // gate would have read the state of the PREVIOUS attempt.
    finalizeRunOutcome(
      ctx,
      { runId: opts.runId, dryRun: opts.dryRun, partial: outcome.partial },
      summary,
    );
    // A successful run that moved no cursor still counts as "ran today",
    // otherwise a scheduled no-op repeats every tick. A FAILED run does not
    // touch lastRunAt — it stays retryable — but its failure IS counted, and
    // that count is what bounds the retries (contract retry_budget).
    await finalizeCheckpointAfterRun({
      ctx,
      runId: opts.runId,
      advance: outcome.advance,
      cursor,
      newL0,
      summary,
    });
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
    // Count this failure too: an unexpected error (broken checkpoint, db
    // trouble) is exactly the kind of breakage that would otherwise re-spawn
    // a sub-session on every tick, unbounded by the retry budget.
    if (!opts.dryRun) {
      try {
        await stampRoleRun(ctx, summary);
      } catch {
        // best-effort: the state that failed the run may also be unwritable
      }
      finalizeRunOutcome(ctx, { runId: opts.runId }, summary);
    }
    return summary;
  } finally {
    ctx.childrenRef.value.delete(opts.runId);
    // `keep_scratch` hands the attempt dir to retention instead of deleting it
    // here (tz-02 критерий 4). Deleting it unconditionally is what made a run
    // impossible to take apart afterwards: by the time anyone looked, the
    // input, the candidate and the verdict were gone.
    if (!opts.dryRun && !opts.contract.assets.keepScratch) {
      try {
        await fs.promises.rm(runScratch, { recursive: true, force: true });
      } catch {
        // best-effort scratch cleanup
      }
    }
  }
}
