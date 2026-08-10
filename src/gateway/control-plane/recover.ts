/**
 * Startup recovery of runs left behind by a dead process (tz-09 Ф2, P5).
 *
 * A gateway that dies mid-run leaves rows in `claimed` / `running` /
 * `reviewed` / `applying`, and the child it spawned may still be alive with a
 * scratch dir it is about to write into. Recovery is where the LEASE earns
 * its keep: taking a run over bumps its fence, which is exactly what makes
 * the old child's artefact refusable — and a run caught in `applying` is
 * parked as `needs-reconciliation` instead of being taken over, because its
 * mutations may be halfway through the store.
 *
 * Without this pass `claimRun` would never run in production, `fence` would
 * stay 1 forever and every artefact-fence check downstream would be
 * decorative — the same dead-gate shape tz-09 Ф0 characterized.
 */
import { openControlPlane } from "./db.js";
import { claimRun } from "./lease.js";
import { updateRun } from "./run-repo.js";
import type { RunRow, RunState } from "./run-types.js";

/** States that mean "a process was working on this". */
const LIVE: readonly RunState[] = [
  "claimed",
  "running",
  "reviewed",
  "applying",
];

export interface RecoveredRun {
  runId: string;
  from: RunState;
  to: RunState;
  fence: number;
  reason?: string;
}

function liveRuns(dataDir: string): RunRow[] {
  const db = openControlPlane(dataDir);
  try {
    const placeholders = LIVE.map(() => "?").join(", ");
    return db
      .prepare(`SELECT * FROM runs WHERE state IN (${placeholders})`)
      .all(...LIVE) as RunRow[];
  } finally {
    db.close();
  }
}

/**
 * Take over (or park) every run a previous process left live.
 * @param owner identity of THIS process — a run this owner already holds is
 * not a leftover, so a restart-in-place does not fight itself.
 */
export function recoverOrphanRuns(
  dataDir: string,
  owner: string,
  opts: { nowMs: number; ttlMs: number },
): RecoveredRun[] {
  const recovered: RecoveredRun[] = [];
  for (const row of liveRuns(dataDir)) {
    if (row.leaseOwner === owner) continue;
    const claim = claimRun(dataDir, row.runId, owner, opts);
    if (!claim.ok) {
      // `applying` → claimRun already parked it as needs-reconciliation.
      recovered.push({
        runId: row.runId,
        from: row.state,
        to: claim.row?.state ?? row.state,
        fence: claim.row?.fence ?? row.fence,
        reason: claim.reason,
      });
      continue;
    }
    // The child that was driving this run belongs to a process that is gone.
    // The fence has moved, so its artefact can no longer be applied; the run
    // itself is over, and a NEW run is the reaction (P9 §4.2).
    updateRun(
      dataDir,
      row.runId,
      {
        state: "failed",
        errorClass: "orphan-run",
        finishedAt: new Date(opts.nowMs).toISOString(),
      },
      new Date(opts.nowMs).toISOString(),
    );
    recovered.push({
      runId: row.runId,
      from: row.state,
      to: "failed",
      fence: claim.fence,
      reason: "taken over from a dead process",
    });
  }
  return recovered;
}
