import { L1AgentPersistenceError } from "../../core/record/l1-agent-errors.js";
import { openControlPlane } from "../control-plane/db.js";
import type { L1AssignmentRow, L1AssignmentState } from "./l1-control-types.js";

export function readL1Assignment(
  dataDir: string,
  assignmentId: string,
): L1AssignmentRow | null {
  const db = openControlPlane(dataDir);
  try {
    const row = db
      .prepare("SELECT * FROM l1_assignments WHERE assignmentId = ?")
      .get(assignmentId);
    return (row as L1AssignmentRow | undefined) ?? null;
  } finally {
    db.close();
  }
}

export function startL1AssignmentEpoch(input: {
  dataDir: string;
  assignmentId: string;
  runId: string;
  roleContractHash: string;
  nowMs: number;
  nowIso: string;
}): boolean {
  const db = openControlPlane(input.dataDir);
  try {
    const result = db
      .prepare(
        `UPDATE l1_assignments SET runId = ?, roleContractHash = ?,
           state = 'running', nextRetryAt = 0, error = NULL, updatedAt = ?
         WHERE assignmentId = ? AND (
           state = 'created' OR
           (state = 'failed' AND (nextRetryAt <= ? OR roleContractHash <> ?))
         )`,
      )
      .run(
        input.runId,
        input.roleContractHash,
        input.nowIso,
        input.assignmentId,
        input.nowMs,
        input.roleContractHash,
      );
    return Number(result.changes ?? 0) === 1;
  } finally {
    db.close();
  }
}

export function failL1Assignment(input: {
  dataDir: string;
  assignmentId: string;
  runId: string;
  error: string;
  nextRetryAt: number;
  nowIso: string;
}): boolean {
  return patchOwnedAssignment(input, "failed", {
    expectedState: "running",
    error: input.error,
    nextRetryAt: input.nextRetryAt,
    shouldIncrementFailure: true,
  });
}

export function markL1AssignmentCommitting(input: {
  dataDir: string;
  assignmentId: string;
  runId: string;
  nowIso: string;
}): boolean {
  return patchOwnedAssignment(input, "committing", {
    expectedState: "reviewed",
  });
}

export function commitL1Assignment(input: {
  dataDir: string;
  assignmentId: string;
  runId: string;
  nowIso: string;
}): boolean {
  return patchOwnedAssignment(input, "committed", {
    expectedState: "committing",
  });
}

function patchOwnedAssignment(
  input: {
    dataDir: string;
    assignmentId: string;
    runId: string;
    nowIso: string;
  },
  state: L1AssignmentState,
  patch: {
    expectedState: L1AssignmentState;
    error?: string;
    nextRetryAt?: number;
    shouldIncrementFailure?: boolean;
  },
): boolean {
  const db = openControlPlane(input.dataDir);
  try {
    const increment = patch.shouldIncrementFailure
      ? "failureCount + 1"
      : "failureCount";
    const result = db
      .prepare(
        `UPDATE l1_assignments SET state = ?, error = ?, nextRetryAt = ?,
           failureCount = ${increment}, updatedAt = ?
         WHERE assignmentId = ? AND runId = ? AND state = ?`,
      )
      .run(
        state,
        patch.error ?? null,
        patch.nextRetryAt ?? 0,
        input.nowIso,
        input.assignmentId,
        input.runId,
        patch.expectedState,
      );
    return Number(result.changes ?? 0) === 1;
  } catch (error) {
    throw new L1AgentPersistenceError("failed to update L1 assignment", {
      cause: error,
    });
  } finally {
    db.close();
  }
}
