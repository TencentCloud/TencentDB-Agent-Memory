/**
 * Run repository (tz-09 Ф1) — the only place that reads/writes `runs`.
 *
 * Opens the control-plane db per call and closes it: runs are created once
 * per role run and read on /status, so a long-lived handle would only add a
 * lock to keep alive across gateway restarts. Lease/fence transitions (Ф2)
 * and the oplog (Ф5) build on the same helpers.
 */
import { openControlPlane } from "./db.js";
import type { CreateRunInput, RunRow, RunState } from "./run-types.js";

const RUN_COLUMNS = `runId, assignmentId, roleId, roleVersion, contractHash,
  contractJson, binding, hostSessionRef, inputDigest, candidateDigest,
  verdictDigest, state, fence, leaseOwner, leaseExpiresAt, errorClass,
  criticReceipt, applyReceipt, sessionPath, scratchPath, logPath, reason,
  createdAt, updatedAt, finishedAt`;

export function createRun(
  dataDir: string,
  input: CreateRunInput,
  nowIso: string,
): RunRow {
  const db = openControlPlane(dataDir);
  try {
    db.prepare(
      `INSERT INTO runs (runId, assignmentId, roleId, roleVersion, contractHash,
         contractJson, binding, hostSessionRef, inputDigest, state, fence,
         sessionPath, scratchPath, logPath, reason, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', 1, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.runId,
      input.assignmentId ?? "",
      input.roleId,
      input.roleVersion ?? "",
      input.contractHash,
      input.contractJson,
      input.binding,
      input.hostSessionRef ?? "",
      input.inputDigest ?? "",
      input.sessionPath ?? "",
      input.scratchPath ?? "",
      input.logPath ?? "",
      input.reason ?? "",
      nowIso,
      nowIso,
    );
    const row = readRunWith(db, input.runId);
    if (row === null) {
      throw new Error(`createRun: run "${input.runId}" vanished after insert`);
    }
    return row;
  } finally {
    db.close();
  }
}

export function readRun(dataDir: string, runId: string): RunRow | null {
  const db = openControlPlane(dataDir);
  try {
    return readRunWith(db, runId);
  } finally {
    db.close();
  }
}

/** Most recent runs, newest first — the /status projection. */
export function listRecentRuns(dataDir: string, limit = 10): RunRow[] {
  const db = openControlPlane(dataDir);
  try {
    const rows = db
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM runs ORDER BY createdAt DESC LIMIT ?`,
      )
      .all(limit);
    return rows as RunRow[];
  } finally {
    db.close();
  }
}

export interface RunPatch {
  state?: RunState;
  candidateDigest?: string;
  verdictDigest?: string;
  errorClass?: string;
  criticReceipt?: string;
  applyReceipt?: string;
  finishedAt?: string;
}

/** Patch a run. Unknown runId → false (never creates a row implicitly). */
export function updateRun(
  dataDir: string,
  runId: string,
  patch: RunPatch,
  nowIso: string,
): boolean {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return false;
  const db = openControlPlane(dataDir);
  try {
    if (readRunWith(db, runId) === null) return false;
    const setSql = entries.map(([k]) => `${k} = ?`).join(", ");
    db.prepare(`UPDATE runs SET ${setSql}, updatedAt = ? WHERE runId = ?`).run(
      ...entries.map(([, v]) => v as string),
      nowIso,
      runId,
    );
    return true;
  } finally {
    db.close();
  }
}

function readRunWith(
  db: ReturnType<typeof openControlPlane>,
  runId: string,
): RunRow | null {
  const row = db
    .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE runId = ?`)
    .get(runId);
  return (row as RunRow | undefined) ?? null;
}
