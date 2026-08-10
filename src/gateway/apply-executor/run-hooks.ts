/**
 * What an apply does to its Run (tz-09 Ф5/Ф7).
 *
 * All three hooks are no-ops without a run identity, which is what keeps the
 * pre-tz-09 direct call sites working unchanged: no run, no journal, no state
 * transition — just the mutations.
 */
import { beginApplying, finishApplying } from "../control-plane/applying.js";
import { countOps, createOpJournal, type OnOp } from "./op-journal.js";
import { ApplyValidationError } from "./errors.js";
import type { ApplyExecutorDeps } from "./apply-executor-deps.js";
import type { RunContext } from "./run-context.js";
import type { ApplyDiff } from "./schemas.js";

function scopedRunId(
  deps: ApplyExecutorDeps,
  run: RunContext | undefined,
): string | undefined {
  return deps.runRepo === true ? run?.runId : undefined;
}

/** The single door into `applying` (criterion 2): a second handler of the
 * same run is refused here, before it can mutate anything. */
export function enterApplying(
  deps: ApplyExecutorDeps,
  run: RunContext | undefined,
): void {
  const runId = scopedRunId(deps, run);
  if (runId === undefined) return;
  const door = beginApplying(deps.dataDir, runId, new Date().toISOString());
  if (!door.ok) {
    throw new ApplyValidationError(
      `apply refused: ${door.reason ?? "run is already applying"}`,
    );
  }
}

/** Leave `applying` once the mutations returned. A failure deliberately does
 * NOT leave it: a run stuck in `applying` is the signal that the store may be
 * half-written, and the reaction to that is reconciliation (P5). */
export function leaveApplying(
  deps: ApplyExecutorDeps,
  run: RunContext | undefined,
): void {
  const runId = scopedRunId(deps, run);
  if (runId === undefined) return;
  finishApplying(deps.dataDir, runId, "applied", new Date().toISOString());
}

/** A journal when the caller named a run AND a candidate; a direct apply has
 * nothing to reconcile against. */
export function journalFor(
  deps: ApplyExecutorDeps,
  diff: ApplyDiff,
  run: RunContext | undefined,
): OnOp | undefined {
  if (run?.runId === undefined || run.candidateDigest === undefined) {
    return undefined;
  }
  return createOpJournal(
    {
      dataDir: deps.dataDir,
      runId: run.runId,
      candidateDigest: run.candidateDigest,
      now: () => Date.now(),
    },
    countOps(diff),
  );
}
