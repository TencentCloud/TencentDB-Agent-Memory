/**
 * Row-level helpers shared by lease.ts and fence.ts (tz-09 Ф2).
 *
 * Kept separate so both files stay ≤150 lines and there is exactly ONE way to
 * read a run row inside the control plane.
 */
import type { openControlPlane } from "./db.js";
import type { RunRow } from "./run-types.js";

export type ControlDb = ReturnType<typeof openControlPlane>;

export function readRunRow(db: ControlDb, runId: string): RunRow | null {
  const row = db.prepare(`SELECT * FROM runs WHERE runId = ?`).get(runId);
  return (row as RunRow | undefined) ?? null;
}

/** A run whose owner died mid-apply: the store shape is unknown, so the run
 * is parked instead of being handed to a new owner (P5). */
export function markNeedsReconciliation(
  db: ControlDb,
  runId: string,
  nowMs: number,
): void {
  db.prepare(
    `UPDATE runs SET state = 'needs-reconciliation', updatedAt = ? WHERE runId = ?`,
  ).run(new Date(nowMs).toISOString(), runId);
}
