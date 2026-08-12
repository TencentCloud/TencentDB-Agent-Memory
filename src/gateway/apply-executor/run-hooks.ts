/**
 * What an apply does to its Run (tz-09 Ф5/Ф7).
 *
 * All three hooks are no-ops without a run identity, which is what keeps the
 * pre-tz-09 direct call sites working unchanged: no run, no journal, no state
 * transition — just the mutations.
 */
import { beginApplying, finishApplying } from "../control-plane/applying.js";
import {
  countOps,
  createOpJournal,
  digestOf,
  recordPlan,
  type OnOp,
} from "./op-journal.js";
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
 * same run is refused here, before it can mutate anything. Returns whether
 * THIS call opened the door — the caller must not later write a state onto a
 * run it never entered. */
export function enterApplying(
  deps: ApplyExecutorDeps,
  run: RunContext | undefined,
): boolean {
  const runId = scopedRunId(deps, run);
  if (runId === undefined) return false;
  const door = beginApplying(deps.dataDir, runId, new Date().toISOString());
  if (!door.ok) {
    throw new ApplyValidationError(
      `apply refused: ${door.reason ?? "run is already applying"}`,
    );
  }
  return true;
}

/** Leave `applying` for the state the OUTCOME earned — called on every exit
 * path, including the failing ones. Leaving a run in `applying` would wedge
 * it forever: takeover from `applying` is forbidden (P5) and the door refuses
 * every later apply, so nothing could ever resolve it. A run that mutated and
 * then failed is parked for reconciliation; one that never mutated failed
 * outright.
 *
 * `entered` is not a formality: a handler REFUSED at the door would otherwise
 * write its own outcome onto the run that is still applying, and the real
 * owner's `finishApplying` — conditioned on `state = 'applying'` — would then
 * silently do nothing, losing the outcome of a half-written store. */
export function leaveApplying(
  deps: ApplyExecutorDeps,
  run: RunContext | undefined,
  outcome: { ok: boolean; mutated: boolean; entered: boolean },
): void {
  if (!outcome.entered) return;
  const runId = scopedRunId(deps, run);
  if (runId === undefined) return;
  // A successful apply that does not close the run leaves it WORKING: the
  // next batch of the same run still has to be able to hand in its artefact,
  // and `applied` is terminal (fence.ts:15 refuses artefacts of a run that is
  // over). The run's own finalization writes the terminal state.
  const state = outcome.ok
    ? (run?.closesRun ?? true)
      ? "applied"
      : "running"
    : outcome.mutated
      ? "needs-reconciliation"
      : "failed";
  finishApplying(deps.dataDir, runId, state, new Date().toISOString());
}

/** A journal whenever the caller named a run; a direct apply has nothing to
 * reconcile against. The candidate digest falls back to the candidate ITSELF,
 * so a caller that names a run but no digest (the HTTP path) still gets a
 * journal instead of silently getting none. */
export function journalFor(
  deps: ApplyExecutorDeps,
  diff: ApplyDiff,
  run: RunContext | undefined,
): OnOp | undefined {
  if (run?.runId === undefined) return undefined;
  const journalDeps = {
    dataDir: deps.dataDir,
    runId: run.runId,
    candidateDigest: run.candidateDigest ?? digestOf(JSON.stringify(diff)),
    now: () => Date.now(),
  };
  // The whole plan lands BEFORE the first mutation, so a crash halfway leaves
  // a record of the operations that never started (tz-09 Ф5, P8).
  recordPlan(journalDeps, diff);
  return createOpJournal(journalDeps, countOps(diff));
}
