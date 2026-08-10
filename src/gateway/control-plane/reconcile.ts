/**
 * Reconciliation (tz-09 Ф5, P8).
 *
 * A run that crashed mid-apply is parked in `needs-reconciliation`. The only
 * way out is to READ THE STORE BACK: for every journalled operation, does its
 * postcondition hold now? Operations that hold become `verified`; anything
 * that does not keeps the run parked, with the reason spelled out per op.
 *
 * Deliberately read-only about the STORE: reconciliation never re-applies and
 * never rolls back. It reports what is true, and re-running it changes nothing
 * (`verified` is a terminal op state — oplog.ts).
 */
import { listOps, markVerified } from "./oplog.js";
import {
  checkPostcondition,
  type PostconditionResult,
} from "./postcondition.js";
import { updateRun } from "./run-repo.js";

export interface ReconcileReport {
  runId: string;
  total: number;
  verified: number;
  /** Ops whose postcondition does NOT hold — the run stays parked. */
  unresolved: PostconditionResult[];
  /** Target keys of operations the candidate planned but never attempted.
   * They are not failures: nothing was written for them, so there is nothing
   * to verify — but they are the difference between "this apply is complete"
   * and "this apply stopped early", which is what an operator needs. */
  notAttempted: string[];
  resolved: boolean;
}

/** Verify one run's journal against the store. `resolved` is true only when
 * every operation's postcondition holds; then the run becomes `applied`. */
export function reconcileRun(
  dataDir: string,
  runId: string,
  nowIso: string,
): ReconcileReport {
  const all = listOps(dataDir, runId);
  const notAttempted = all
    .filter((op) => op.state === "planned")
    .map((op) => op.targetKey);
  const ops = all.filter((op) => op.state !== "planned");
  const unresolved: PostconditionResult[] = [];
  let verified = 0;

  for (const op of ops) {
    const result = checkPostcondition(dataDir, op);
    if (result.holds) {
      verified += 1;
      if (op.state !== "verified") {
        markVerified(dataDir, op.operationId, nowIso);
      }
    } else {
      unresolved.push(result);
    }
  }

  const resolved = ops.length > 0 && unresolved.length === 0;
  if (resolved) {
    // Resolved means the store is KNOWN, not that the candidate applied in
    // full: this path is reached from a partial apply, where the operations
    // that never started have no journal row to verify. So the run leaves
    // ambiguity for a terminal failure, keeping errorClass as the reason and
    // the oplog as the record of what actually landed.
    updateRun(dataDir, runId, { state: "failed", finishedAt: nowIso }, nowIso);
  }
  return {
    runId,
    total: ops.length,
    verified,
    unresolved,
    notAttempted,
    resolved,
  };
}
