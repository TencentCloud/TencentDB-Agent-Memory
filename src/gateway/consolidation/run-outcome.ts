/**
 * Run outcome → control plane (tz-09 Ф2b).
 *
 * Classifies how a run ended and writes the class onto the Run row, then
 * moves the run to the state its class demands. Without this the classifier
 * would be exactly what `assertOpsSubset` was before Ф3: correct, tested and
 * never reached.
 *
 * Terminal-for-run classes park the run so the next dispatch cannot pick it
 * up as if nothing happened — a partial apply becomes `needs-reconciliation`,
 * a stale workset becomes `failed` (a NEW run is the reaction, not a retry).
 */
import { updateRun } from "../control-plane/run-repo.js";
import { reconcileRun } from "../control-plane/reconcile.js";
import { cancelRun } from "../control-plane/lease.js";
import { runOwnerId } from "../control-plane/owner.js";
import {
  classifyFailure,
  reactionFor,
  type FailureClass,
} from "../control-plane/failure-class.js";
import type { OrchestratorContext } from "./context.js";
import type { RunSummary } from "./types.js";

export interface RunOutcomeInput {
  runId: string;
  dryRun?: boolean;
  /** Apply mutated and then aborted — from RunBatchResult.partial. */
  partial?: boolean;
  timedOut?: boolean;
}

/** Record the end of a run. Never throws: the control plane is state, not the
 * run itself (the hard gate is Ф6). */
export function finalizeRunOutcome(
  ctx: OrchestratorContext,
  input: RunOutcomeInput,
  summary: RunSummary,
): FailureClass | null {
  if (input.dryRun === true) return null;
  const nowIso = new Date(ctx.now()).toISOString();
  try {
    const guard = { owner: runOwnerId(ctx.ownerPid) };
    if (summary.status === "ok") {
      if (
        !updateRun(
          ctx.dataDir,
          input.runId,
          { state: "applied", finishedAt: nowIso },
          nowIso,
          guard,
        )
      ) {
        // Not ours any more: another owner took the run over while this
        // process was finishing. Its outcome is the one that counts.
        ctx.logger.warn?.(
          `[run] outcome for ${input.runId} refused: run no longer owned here`,
        );
      }
      return null;
    }
    if (summary.status === "dry-run" || summary.status === "disabled") {
      return null;
    }

    const cls = classifyFailure({
      stage: summary.child === undefined ? "launch" : "apply",
      message: summary.error ?? "",
      partial: input.partial,
      timedOut: input.timedOut ?? summary.child?.timedOut,
    });
    const reaction = reactionFor(cls);
    updateRun(
      ctx.dataDir,
      input.runId,
      {
        errorClass: cls,
        state:
          cls === "partial-apply"
            ? "needs-reconciliation"
            : reaction.terminalForRun
              ? "failed"
              : "running",
        finishedAt: reaction.terminalForRun ? nowIso : undefined,
      },
      nowIso,
      guard,
    );
    ctx.logger.warn?.(
      `[run] ${summary.role}/${input.runId} failed: class=${cls} ` +
        `reaction=${reaction.reaction} terminal=${reaction.terminalForRun}`,
    );
    if (cls === "timeout-cancel") {
      // `cancel-means-no-late-apply`: the child was killed but may still be
      // writing. Cancelling bumps the fence, which is what makes the artefact
      // it leaves behind unusable (control-plane/fence.ts).
      cancelRun(ctx.dataDir, input.runId, ctx.now());
    }
    if (cls === "partial-apply") {
      // Read the store back immediately: an apply that aborted after every
      // journalled op had already landed is complete, not partial (Ф5/P8).
      const report = reconcileRun(ctx.dataDir, input.runId, nowIso);
      ctx.logger.warn?.(
        `[run] ${input.runId} reconcile: ${report.verified}/${report.total} ` +
          `verified resolved=${report.resolved}` +
          (report.unresolved.length === 0
            ? ""
            : ` unresolved=${report.unresolved
                .map((u) => `${u.opIndex}:${u.detail}`)
                .join("; ")}`),
      );
    }
    return cls;
  } catch (err) {
    ctx.logger.warn?.(
      `[run] outcome write failed for ${input.runId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
