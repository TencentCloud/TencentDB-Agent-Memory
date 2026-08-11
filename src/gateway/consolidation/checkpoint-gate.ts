/**
 * The one gate between a finished run and the checkpoint (tz-03a).
 *
 * Two rules meet here, and they are NOT the same rule:
 *
 *  1. The cursor moves only after a complete apply — the run has reached
 *     `applied` in the control plane — and only once per runId.
 *  2. The per-role stamp is written ALWAYS. It answers "did this role run
 *     today", which the dispatcher asks before scheduling; skipping it on a
 *     blocked advance would re-spawn the role every tick, forever.
 *
 * `applied` and not `verified`: reconcileRun (run-outcome.ts) only runs in the
 * partial-apply branch, so on the happy path `verified` never arrives and a
 * gate waiting for it would block the cursor permanently.
 */
import { readRun } from "../control-plane/run-repo.js";
import {
  claimCheckpointFinalization,
  releaseCheckpointFinalization,
} from "../control-plane/checkpoint-claim.js";
import { advanceCheckpoint, stampRoleRun } from "./checkpoint-advance.js";
import type { L0Cursor } from "./diff-builder.js";
import type { OrchestratorContext } from "./context.js";
import type { RunSummary } from "./types.js";

export interface CheckpointGateArgs {
  ctx: OrchestratorContext;
  runId: string;
  /** The strategy's advance decision — absent means "nothing to move". */
  advance?: { anchor: L0Cursor | undefined };
  /** Cursor snapshot this run started from (diagnostic). */
  cursor: L0Cursor;
  newL0: number;
  summary: RunSummary;
}

export async function finalizeCheckpointAfterRun(
  args: CheckpointGateArgs,
): Promise<void> {
  const { ctx, runId, advance, cursor, newL0, summary } = args;
  // The control plane is state, not the run (run-outcome.ts). A broken
  // control-plane db must not turn an applied run into an unexpected run
  // error — it holds the cursor, which is the safe direction, and says so.
  let state = "(unreadable)";
  try {
    state = readRun(ctx.dataDir, runId)?.state ?? "(missing)";
  } catch (err) {
    ctx.logger.warn?.(
      `[checkpoint] control-plane unreadable for ${runId}: ` +
        `${err instanceof Error ? err.message : String(err)} — cursor held`,
    );
  }
  const mayAdvance = advance !== undefined && state === "applied";
  let claimed = false;
  if (mayAdvance) {
    try {
      claimed = claimCheckpointFinalization(
        ctx.dataDir,
        runId,
        new Date(ctx.now()).toISOString(),
      );
    } catch (err) {
      ctx.logger.warn?.(
        `[checkpoint] finalization claim failed for ${runId}: ` +
          `${err instanceof Error ? err.message : String(err)} — cursor held`,
      );
    }
  }

  if (claimed) {
    try {
      await advanceCheckpoint(ctx, cursor, newL0, summary, advance?.anchor);
      return;
    } catch (err) {
      // The claim is taken BEFORE the work so a concurrent retry cannot slip
      // in between; if the work then fails (the checkpoint lock timing out
      // after its holder was killed, say), keeping the claim would burn this
      // run's advance forever. Give it back and let the failure surface.
      releaseCheckpointFinalization(ctx.dataDir, runId);
      ctx.logger.warn?.(
        `[checkpoint] advance failed for ${runId}, claim released: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }
  if (mayAdvance) {
    // The run applied, but its checkpoint was already finalized — a retry
    // after a crash between apply and finalization. Re-running the formula
    // would be harmless today (it recomputes), but the claim is what keeps
    // that true if the counter ever grows a cheaper path again.
    ctx.logger.debug?.(
      `[checkpoint] ${runId} already finalized — advance skipped`,
    );
  } else if (advance !== undefined) {
    ctx.logger.warn?.(
      `[checkpoint] ${runId} wanted to advance but its state is ${state} — cursor held`,
    );
  }
  await stampRoleRun(ctx, summary);
}
