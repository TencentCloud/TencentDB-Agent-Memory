import { L1AgentPersistenceError } from "../../core/record/l1-agent-errors.js";
import { openControlPlane } from "../control-plane/db.js";
import type { L1AttemptArtifactRow } from "./l1-control-types.js";

export function createL1AttemptArtifact(input: {
  dataDir: string;
  row: Omit<L1AttemptArtifactRow, "state" | "createdAt" | "updatedAt">;
  nowIso: string;
}): void {
  const { row } = input;
  const db = openControlPlane(input.dataDir);
  try {
    db.prepare(
      `INSERT INTO l1_attempt_artifacts
       (attemptId, assignmentId, runId, fence, ordinal, worksetDigest,
        reviewInputJson, reviewInputDigest, candidateJson, candidateDigest,
        state, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?)`,
    ).run(
      row.attemptId,
      row.assignmentId,
      row.runId,
      row.fence,
      row.ordinal,
      row.worksetDigest,
      row.reviewInputJson,
      row.reviewInputDigest,
      row.candidateJson,
      row.candidateDigest,
      input.nowIso,
      input.nowIso,
    );
  } finally {
    db.close();
  }
}

/** Close a candidate artifact with the gateway's own validation outcome.
 * Only a row still in `candidate` moves, so a replayed settle is a no-op
 * instead of a state flip. */
export function settleL1Attempt(input: {
  dataDir: string;
  attemptId: string;
  approved: boolean;
  nowIso: string;
}): boolean {
  const db = openControlPlane(input.dataDir);
  try {
    const result = db
      .prepare(
        `UPDATE l1_attempt_artifacts SET state = ?, updatedAt = ?
         WHERE attemptId = ? AND state = 'candidate'`,
      )
      .run(
        input.approved ? "approved" : "rejected",
        input.nowIso,
        input.attemptId,
      );
    return Number(result.changes ?? 0) === 1;
  } finally {
    db.close();
  }
}

/** Promote the approved artifact onto its assignment.
 *
 * `candidateDigest` is the caller's copy of the bytes it validated. Without
 * that equality a caller with a valid attemptId could promote a row that was
 * written by some other pass — the assignment would then carry a candidate
 * nobody checked. */
export function approveL1Assignment(input: {
  dataDir: string;
  assignmentId: string;
  runId: string;
  attemptId: string;
  candidateDigest: string;
  nowIso: string;
}): boolean {
  const db = openControlPlane(input.dataDir);
  try {
    db.exec("BEGIN IMMEDIATE");
    const artifact = readApprovedArtifact(
      db,
      input.attemptId,
      input.assignmentId,
      input.runId,
    );
    if (
      artifact === null ||
      artifact.candidateDigest !== input.candidateDigest
    ) {
      db.exec("ROLLBACK");
      return false;
    }
    const result = db
      .prepare(
        `UPDATE l1_assignments SET approvedAttemptId = ?, candidateJson = ?,
           candidateDigest = ?, state = 'reviewed', updatedAt = ?
         WHERE assignmentId = ? AND runId = ? AND state = 'running'`,
      )
      .run(
        artifact.attemptId,
        artifact.candidateJson,
        artifact.candidateDigest,
        input.nowIso,
        input.assignmentId,
        input.runId,
      );
    db.exec("COMMIT");
    return Number(result.changes ?? 0) === 1;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* retain original error */
    }
    throw new L1AgentPersistenceError("failed to approve L1 assignment", {
      cause: error,
    });
  } finally {
    db.close();
  }
}

type Db = ReturnType<typeof openControlPlane>;

function readApprovedArtifact(
  db: Db,
  attemptId: string,
  assignmentId: string,
  runId: string,
): L1AttemptArtifactRow | null {
  const row = db
    .prepare(
      `SELECT * FROM l1_attempt_artifacts
     WHERE attemptId = ? AND assignmentId = ? AND runId = ? AND state = 'approved'`,
    )
    .get(attemptId, assignmentId, runId);
  return (row as L1AttemptArtifactRow | undefined) ?? null;
}
