/**
 * The right to finalize a run's checkpoint, claimed exactly once (tz-03a).
 *
 * A run that crashed between applying and finalizing is retried, and the retry
 * must not count its rows a second time. The marker lives in the control plane
 * rather than in the checkpoint file: the file's shape is what the package's
 * risk tier was lowered for, while the control-plane schema is additive by
 * construction (db.ts ADDITIONS).
 *
 * One conditional UPDATE decides it. SQLite makes that statement atomic, so
 * the claim holds between processes too — independently of any file lock.
 */
import { openControlPlane } from "./db.js";

/**
 * Try to become the finalizer of `runId`. Returns true for the first caller
 * and false for every later one (including a caller in another process).
 * A missing row also returns false: a run the control plane never saw has no
 * claim to give.
 */
export function claimCheckpointFinalization(
  dataDir: string,
  runId: string,
  nowIso: string,
): boolean {
  const db = openControlPlane(dataDir);
  try {
    const info = db
      .prepare(
        "UPDATE runs SET checkpointFinalizedAt = ? WHERE runId = ? AND " +
          "(checkpointFinalizedAt IS NULL OR checkpointFinalizedAt = '')",
      )
      .run(nowIso, runId);
    // `Number(...)` and not `=== 1` on the raw value: the driver types changes
    // as number | bigint (http-utils.ts), and bun returns the bigint form.
    return Number(info.changes ?? 0) === 1;
  } finally {
    db.close();
  }
}

/** When this run's checkpoint was finalized ("" = never / unknown run). */
export function checkpointFinalizedAt(dataDir: string, runId: string): string {
  const db = openControlPlane(dataDir);
  try {
    const row = db
      .prepare("SELECT checkpointFinalizedAt AS at FROM runs WHERE runId = ?")
      .get(runId) as { at?: string | null } | null;
    return typeof row?.at === "string" ? row.at : "";
  } finally {
    db.close();
  }
}
