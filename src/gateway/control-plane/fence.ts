/**
 * Artefact fence check (tz-09 Ф2).
 *
 * The fence is only worth anything where an artefact is INGESTED: the child
 * writes `<scratch>/diff.json` and `<scratch>/critic.json` whether or not it
 * still owns the run, so the reader — not the writer — must refuse the ones
 * that belong to a run that has moved on.
 */
import { openControlPlane } from "./db.js";
import { readRunRow } from "./run-row.js";
import type { RunRow, RunState } from "./run-types.js";

/** States in which a run may still produce an artefact. */
const PRODUCING: readonly RunState[] = [
  "created",
  "claimed",
  "running",
  "reviewed",
  "applying",
];

export interface FenceCheck {
  ok: boolean;
  reason?: string;
  row: RunRow | null;
}

/** Accept an artefact only at the CURRENT fence of a run that may still
 * produce one. */
export function checkArtifactFence(
  dataDir: string,
  runId: string,
  fence: number,
): FenceCheck {
  const db = openControlPlane(dataDir);
  try {
    const row = readRunRow(db, runId);
    if (row === null) {
      return { ok: false, reason: `unknown run "${runId}"`, row: null };
    }
    if (row.fence !== fence) {
      return {
        ok: false,
        reason: `stale-fence-rejected: artefact fence ${fence}, run at ${row.fence}`,
        row,
      };
    }
    if (row.state === "cancelled") {
      return { ok: false, reason: "cancelled run: late artefact refused", row };
    }
    if (row.state === "needs-reconciliation") {
      return { ok: false, reason: "run needs reconciliation", row };
    }
    // Every other state that is over refuses too. Listing only the two above
    // let a run that had already FAILED (or applied) still ingest the artefact
    // its dead child left behind — the fence alone does not catch it, because
    // a run recovered from a process that never wrote a lease keeps its fence.
    if (!PRODUCING.includes(row.state)) {
      return {
        ok: false,
        reason: `run is ${row.state}: artefact refused`,
        row,
      };
    }
    return { ok: true, row };
  } finally {
    db.close();
  }
}
