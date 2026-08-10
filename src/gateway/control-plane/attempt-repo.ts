/**
 * Attempt repository (tz-09 Ф1) — LaunchAttempt / CriticAttempt rows.
 *
 * Split from run-repo.ts to keep both files ≤150 lines. Same posture: open
 * the control-plane db per call, close it, never leave a handle behind.
 */
import { randomUUID } from "node:crypto";
import { openControlPlane } from "./db.js";
import type { AttemptKind, AttemptRow } from "./run-types.js";

export function recordAttempt(
  dataDir: string,
  runId: string,
  kind: AttemptKind,
  startedAt: string,
): string {
  const attemptId = randomUUID();
  const db = openControlPlane(dataDir);
  try {
    db.prepare(
      `INSERT INTO attempts (attemptId, runId, kind, startedAt) VALUES (?, ?, ?, ?)`,
    ).run(attemptId, runId, kind, startedAt);
    return attemptId;
  } finally {
    db.close();
  }
}

export function finishAttempt(
  dataDir: string,
  attemptId: string,
  outcome: string,
  detail: string | null,
  finishedAt: string,
): void {
  const db = openControlPlane(dataDir);
  try {
    db.prepare(
      `UPDATE attempts SET outcome = ?, detail = ?, finishedAt = ? WHERE attemptId = ?`,
    ).run(outcome, detail, finishedAt, attemptId);
  } finally {
    db.close();
  }
}

export function listAttempts(dataDir: string, runId: string): AttemptRow[] {
  const db = openControlPlane(dataDir);
  try {
    return db
      .prepare(
        `SELECT attemptId, runId, kind, outcome, detail, startedAt, finishedAt
         FROM attempts WHERE runId = ? ORDER BY startedAt ASC`,
      )
      .all(runId) as AttemptRow[];
  } finally {
    db.close();
  }
}
