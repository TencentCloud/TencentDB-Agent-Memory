import { ownerIsGone } from "../control-plane/owner.js";
import { readRun, updateRun } from "../control-plane/run-repo.js";
import { failL1Assignment, readL1Assignment } from "./l1-assignment-repo.js";
import type { L1AssignmentRow } from "./l1-control-types.js";

/** Turn a dead/expired running epoch back into a retryable assignment. */
export function recoverL1Assignment(
  dataDir: string,
  assignment: L1AssignmentRow,
  nowMs = Date.now(),
): L1AssignmentRow {
  if (assignment.state !== "running" || !assignment.runId) return assignment;
  const run = readRun(dataDir, assignment.runId);
  const isTerminal =
    run === null ||
    ["failed", "cancelled", "needs-reconciliation"].includes(run.state);
  const isOrphan =
    run !== null &&
    (ownerIsGone(run.leaseOwner) || (run.leaseExpiresAt ?? 0) <= nowMs);
  if (!isTerminal && !isOrphan) return assignment;
  const nowIso = new Date(nowMs).toISOString();
  const reason = isTerminal
    ? `orphaned run is ${run?.state ?? "missing"}`
    : "run owner is gone or lease expired";
  failL1Assignment({
    dataDir,
    assignmentId: assignment.assignmentId,
    runId: assignment.runId,
    error: reason,
    nextRetryAt: nowMs,
    nowIso,
  });
  if (run && run.state !== "failed") {
    updateRun(
      dataDir,
      run.runId,
      { state: "failed", errorClass: reason, finishedAt: nowIso },
      nowIso,
    );
  }
  return readL1Assignment(dataDir, assignment.assignmentId) ?? assignment;
}
