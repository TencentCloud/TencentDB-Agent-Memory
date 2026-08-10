/**
 * The one door into `applying` (tz-09 Ф7, criterion 2).
 *
 * Two handlers can see the same `reviewed` run — a retry, a restarted
 * gateway, an operator. Only one of them may start mutating the store, and
 * "check the state, then update it" is not enough: both would read
 * `reviewed`. The transition is therefore a single conditional UPDATE, and
 * the loser learns it lost from the row count, not from a second read.
 */
import { openControlPlane } from "./db.js";
import { readRunRow } from "./run-row.js";
import type { RunState } from "./run-types.js";

/**
 * States a run may enter `applying` from. `applying` itself is absent on
 * purpose: re-entering it is exactly the double-apply this prevents.
 *
 * This door decides WHO applies, not WHETHER the candidate was approved:
 * narrowing it to `reviewed` would also refuse every shadow-mode run, where
 * the critic deliberately writes no receipt. The approval check is
 * run-policy.ts, on the enforce switch, and it runs before this door.
 */
const FROM: readonly RunState[] = ["created", "claimed", "running", "reviewed"];

export interface BeginApplyingResult {
  ok: boolean;
  /** Why the door was closed — for the refusal message. */
  reason?: string;
}

export function beginApplying(
  dataDir: string,
  runId: string,
  nowIso: string,
): BeginApplyingResult {
  const db = openControlPlane(dataDir);
  try {
    const before = readRunRow(db, runId);
    if (before === null) return { ok: false, reason: "unknown run" };
    const placeholders = FROM.map(() => "?").join(", ");
    db.prepare(
      `UPDATE runs SET state = 'applying', updatedAt = ?
       WHERE runId = ? AND state IN (${placeholders})`,
    ).run(nowIso, runId, ...FROM);
    const after = readRunRow(db, runId);
    if (
      after !== null &&
      after.state === "applying" &&
      before.state !== "applying"
    ) {
      return { ok: true };
    }
    return { ok: false, reason: `run is ${before.state}` };
  } finally {
    db.close();
  }
}

/** Leave `applying` for a terminal state after the mutations returned. */
export function finishApplying(
  dataDir: string,
  runId: string,
  state: RunState,
  nowIso: string,
): void {
  const db = openControlPlane(dataDir);
  try {
    db.prepare(
      `UPDATE runs SET state = ?, updatedAt = ?, finishedAt = ?
       WHERE runId = ? AND state = 'applying'`,
    ).run(state, nowIso, nowIso, runId);
  } finally {
    db.close();
  }
}
