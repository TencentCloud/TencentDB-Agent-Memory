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

/** Leave `applying` for the state the OUTCOME earned — called on every exit
 * path, including the failing ones. Leaving a run in `applying` would wedge
 * it forever: takeover from `applying` is forbidden (P5) and the door refuses
 * every later apply, so nothing could ever resolve it. A run that mutated and
 * then failed is parked for reconciliation; one that never mutated failed
 * outright. */
export function leaveApplying(
  deps: ApplyExecutorDeps,
  run: RunContext | undefined,
  outcome: { ok: boolean; mutated: boolean },
): void {
  const runId = scopedRunId(deps, run);
  if (runId === undefined) return;
  const state = outcome.ok
    ? "applied"
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
  return createOpJournal(
    {
      dataDir: deps.dataDir,
      runId: run.runId,
      candidateDigest: run.candidateDigest ?? digestOf(JSON.stringify(diff)),
      now: () => Date.now(),
    },
    countOps(diff),
  );
}
