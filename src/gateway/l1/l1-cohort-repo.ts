import { L1AgentPersistenceError } from "../../core/record/l1-agent-errors.js";
import { openControlPlane } from "../control-plane/db.js";
import { insertL1Assignment, insertL1Cohort } from "./l1-cohort-write.js";
import type {
  CreateL1CohortInput,
  L1AssignmentRow,
  L1CohortRow,
} from "./l1-control-types.js";

export function createL1Cohort(
  dataDir: string,
  input: CreateL1CohortInput,
  nowIso: string,
): void {
  const db = openControlPlane(dataDir);
  try {
    db.exec("BEGIN IMMEDIATE");
    insertL1Cohort(db, input, nowIso);
    input.assignments.forEach((assignment, ordinal) =>
      insertL1Assignment(db, input.cohortId, ordinal, assignment, nowIso),
    );
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The original persistence failure is the actionable error.
    }
    throw new L1AgentPersistenceError("failed to create L1 cohort", {
      cause: error,
    });
  } finally {
    db.close();
  }
}

export function readOldestOpenL1Cohort(
  dataDir: string,
  sessionKey: string,
): L1CohortRow | null {
  const db = openControlPlane(dataDir);
  try {
    const row = db
      .prepare(
        `SELECT * FROM l1_cohorts
         WHERE sessionKey = ? AND state = 'open'
         ORDER BY createdAt ASC, cohortId ASC LIMIT 1`,
      )
      .get(sessionKey);
    return (row as L1CohortRow | undefined) ?? null;
  } finally {
    db.close();
  }
}

export function listL1CohortAssignments(
  dataDir: string,
  cohortId: string,
): L1AssignmentRow[] {
  const db = openControlPlane(dataDir);
  try {
    return db
      .prepare(
        `SELECT * FROM l1_assignments WHERE cohortId = ?
         ORDER BY ordinal ASC`,
      )
      .all(cohortId) as L1AssignmentRow[];
  } finally {
    db.close();
  }
}

export function commitL1Cohort(
  dataDir: string,
  cohortId: string,
  nowIso: string,
): boolean {
  const db = openControlPlane(dataDir);
  try {
    db.exec("BEGIN IMMEDIATE");
    const pending = db
      .prepare(
        `SELECT COUNT(*) AS count FROM l1_assignments
         WHERE cohortId = ? AND state <> 'committed'`,
      )
      .get(cohortId) as { count: number };
    if (Number(pending.count) !== 0) {
      db.exec("ROLLBACK");
      return false;
    }
    const result = db
      .prepare(
        `UPDATE l1_cohorts SET state = 'committed', updatedAt = ?
         WHERE cohortId = ? AND state = 'open'`,
      )
      .run(nowIso, cohortId);
    db.exec("COMMIT");
    return Number(result.changes ?? 0) === 1;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original persistence failure.
    }
    throw new L1AgentPersistenceError("failed to commit L1 cohort", {
      cause: error,
    });
  } finally {
    db.close();
  }
}
