/**
 * Lease + fence (tz-09 Ф2, P3/P4/P5).
 *
 * Exactly one owner may drive a Run at a time. The lease is a row-level
 * condition, not a file: a single conditional UPDATE decides the winner, so
 * two processes racing on the same run cannot both win. Every takeover bumps
 * `fence`, and every artefact produced by a previous owner carries the OLD
 * fence — which is how a killed-then-taken-over attempt is stopped from
 * writing into the run it no longer owns.
 *
 * P5: a run in `applying` is NEVER taken over. Its mutations may be halfway
 * through the store, so the only safe move is `needs-reconciliation`.
 */
import { openControlPlane } from "./db.js";
import { markNeedsReconciliation, readRunRow as read } from "./run-row.js";
import type { RunRow, RunState } from "./run-types.js";

export type ClaimResult =
  | { ok: true; fence: number; row: RunRow }
  | { ok: false; reason: string; row: RunRow | null };

const CLAIMABLE: readonly RunState[] = [
  "created",
  "claimed",
  "running",
  "reviewed",
];

/**
 * Take (or take over) the lease. Succeeds when the run is unowned, owned by
 * `owner`, or its lease has expired. Refuses `applying` (P5) and every
 * terminal state.
 */
export function claimRun(
  dataDir: string,
  runId: string,
  owner: string,
  opts: { nowMs: number; ttlMs: number; state?: RunState },
): ClaimResult {
  const db = openControlPlane(dataDir);
  try {
    const before = read(db, runId);
    if (before === null) return { ok: false, reason: "unknown run", row: null };
    if (before.state === "applying") {
      // Someone died mid-apply: the store is in an unknown shape.
      markNeedsReconciliation(db, runId, opts.nowMs);
      return {
        ok: false,
        reason: "run is applying — needs reconciliation",
        row: before,
      };
    }
    if (!CLAIMABLE.includes(before.state)) {
      return { ok: false, reason: `run is ${before.state}`, row: before };
    }

    const takeover =
      before.leaseOwner !== null &&
      before.leaseOwner !== owner &&
      (before.leaseExpiresAt ?? 0) > opts.nowMs;
    if (takeover) {
      return { ok: false, reason: `held by ${before.leaseOwner}`, row: before };
    }

    // The bump happens only when the lease changes hands: re-claiming your own
    // lease must not invalidate the artefacts you already produced.
    const bump =
      before.leaseOwner !== null && before.leaseOwner !== owner ? 1 : 0;
    const nowIso = new Date(opts.nowMs).toISOString();
    db.prepare(
      `UPDATE runs SET leaseOwner = ?, leaseExpiresAt = ?, fence = fence + ?,
         state = ?, updatedAt = ?
       WHERE runId = ?
         AND (leaseOwner IS NULL OR leaseOwner = ? OR leaseExpiresAt <= ?)
         AND state != 'applying'`,
    ).run(
      owner,
      opts.nowMs + opts.ttlMs,
      bump,
      opts.state ?? (before.state === "created" ? "claimed" : before.state),
      nowIso,
      runId,
      owner,
      opts.nowMs,
    );

    const after = read(db, runId);
    if (after === null || after.leaseOwner !== owner) {
      return { ok: false, reason: "lost the claim race", row: after };
    }
    return { ok: true, fence: after.fence, row: after };
  } finally {
    db.close();
  }
}

/** Move to a new state, but only while `owner` still holds the lease at
 * `fence`. This is the write half of the fence: a stale owner cannot advance
 * the run it lost. */
export function writeWithFence(
  dataDir: string,
  runId: string,
  owner: string,
  fence: number,
  state: RunState,
  nowMs: number,
): boolean {
  const db = openControlPlane(dataDir);
  try {
    db.prepare(
      `UPDATE runs SET state = ?, updatedAt = ?
       WHERE runId = ? AND leaseOwner = ? AND fence = ?`,
    ).run(state, new Date(nowMs).toISOString(), runId, owner, fence);
    const after = read(db, runId);
    return after !== null && after.state === state;
  } finally {
    db.close();
  }
}

/** Cancel: the run stops being applicable AND its fence moves, so an artefact
 * already on disk cannot be applied afterwards (`cancel-means-no-late-apply`). */
export function cancelRun(
  dataDir: string,
  runId: string,
  nowMs: number,
): boolean {
  const db = openControlPlane(dataDir);
  try {
    const before = read(db, runId);
    if (before === null || before.state === "applied") return false;
    db.prepare(
      `UPDATE runs SET state = 'cancelled', fence = fence + 1, leaseOwner = NULL,
         leaseExpiresAt = NULL, updatedAt = ?, finishedAt = ?
       WHERE runId = ?`,
    ).run(new Date(nowMs).toISOString(), new Date(nowMs).toISOString(), runId);
    return true;
  } finally {
    db.close();
  }
}
