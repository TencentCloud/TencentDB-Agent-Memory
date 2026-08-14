import { openControlPlane } from "../control-plane/db.js";
import type {
  L1AssignmentRow,
  L1AttemptArtifactRow,
} from "./l1-control-types.js";

export interface L1StatusProjection {
  assignmentId: string;
  assignmentState: L1AssignmentRow["state"];
  runId: string | null;
  runState: string | null;
  errorKind: string | null;
  extractorAttemptId: string | null;
  extractorOutcome: string | null;
  criticAttemptId: string | null;
  criticOutcome: string | null;
  criticVerdict: string | null;
  commitState: "not-started" | "planned" | "prepared" | "applied" | "verified";
  verifiedOperations: number;
  totalOperations: number;
  updatedAt: string;
}

export function readLatestL1Status(dataDir: string): L1StatusProjection | null {
  const db = openControlPlane(dataDir);
  try {
    const assignment = db.prepare(
      `SELECT * FROM l1_assignments ORDER BY updatedAt DESC, assignmentId DESC LIMIT 1`,
    ).get() as L1AssignmentRow | undefined;
    if (!assignment) return null;
    const run = assignment.runId
      ? db.prepare("SELECT state, errorClass FROM runs WHERE runId = ?").get(assignment.runId) as
          | { state: string; errorClass: string | null }
          | undefined
      : undefined;
    const artifact = db.prepare(
      `SELECT * FROM l1_attempt_artifacts WHERE assignmentId = ?
       ORDER BY updatedAt DESC, ordinal DESC LIMIT 1`,
    ).get(assignment.assignmentId) as L1AttemptArtifactRow | undefined;
    const attemptOutcome = (attemptId: string | null | undefined) =>
      attemptId
        ? (db.prepare("SELECT outcome FROM attempts WHERE attemptId = ?").get(attemptId) as
            | { outcome: string | null }
            | undefined)?.outcome ?? null
        : null;
    const opStates = assignment.runId
      ? db.prepare(
          "SELECT state FROM oplog WHERE runId = ? AND opType = 'storeL1'",
        ).all(assignment.runId) as Array<{ state: L1StatusProjection["commitState"] }>
      : [];
    return {
      assignmentId: assignment.assignmentId,
      assignmentState: assignment.state,
      runId: assignment.runId,
      runState: run?.state ?? null,
      errorKind: run?.errorClass ?? (assignment.error ? "assignment-failed" : null),
      extractorAttemptId: artifact?.attemptId ?? null,
      extractorOutcome: attemptOutcome(artifact?.attemptId),
      criticAttemptId: artifact?.criticAttemptId ?? null,
      criticOutcome: attemptOutcome(artifact?.criticAttemptId),
      criticVerdict: verdictOf(artifact?.verdictJson),
      commitState: commitStateOf(opStates.map(({ state }) => state)),
      verifiedOperations: opStates.filter(({ state }) => state === "verified").length,
      totalOperations: opStates.length,
      updatedAt: assignment.updatedAt,
    };
  } finally {
    db.close();
  }
}

function verdictOf(raw: string | null | undefined): string | null {
  try {
    return raw ? String((JSON.parse(raw) as { verdict?: unknown }).verdict ?? "") || null : null;
  } catch { return null; }
}

function commitStateOf(states: L1StatusProjection["commitState"][]): L1StatusProjection["commitState"] {
  if (states.length === 0) return "not-started";
  if (states.every((state) => state === "verified")) return "verified";
  return (["applied", "prepared", "planned"] as const).find((state) =>
    states.includes(state),
  ) ?? "planned";
}

export function readLatestL1Assignment(
  dataDir: string,
  sessionKey: string,
): L1AssignmentRow | null {
  const db = openControlPlane(dataDir);
  try {
    const row = db
      .prepare(
        `SELECT * FROM l1_assignments WHERE sessionKey = ?
         ORDER BY createdAt DESC, assignmentId DESC LIMIT 1`,
      )
      .get(sessionKey);
    return (row as L1AssignmentRow | undefined) ?? null;
  } finally {
    db.close();
  }
}

export function readL1AttemptArtifact(
  dataDir: string,
  attemptId: string,
): L1AttemptArtifactRow | null {
  const db = openControlPlane(dataDir);
  try {
    const row = db
      .prepare("SELECT * FROM l1_attempt_artifacts WHERE attemptId = ?")
      .get(attemptId);
    return (row as L1AttemptArtifactRow | undefined) ?? null;
  } finally {
    db.close();
  }
}
