/**
 * Run identity + policy resolution (tz-09 Ф6, P6, criterion 1).
 *
 * With `runRepo` on, an apply must name a Run that EXISTS and is still live,
 * and the ops/caps policy is read from that Run's pinned contract snapshot —
 * not from whatever the caller passed. A policy supplied by the caller is a
 * policy the caller can widen; the snapshot was pinned before the child was
 * ever spawned (execute-run.ts).
 *
 * `runRepo` off is the documented rollback: the executor behaves exactly as
 * it did before tz-09, which is also why the pre-existing direct call sites
 * keep working untouched.
 */
import { readRun } from "../control-plane/run-repo.js";
import { ApplyValidationError } from "./errors.js";
import { digestOf } from "./op-journal.js";
import type { ApplyOp } from "./schemas.js";
import type { RunContext } from "./run-context.js";
import type { RunRow } from "../control-plane/run-types.js";
import type { ApplyExecutorDeps } from "./apply-executor-deps.js";

/** States that must never mutate the store: the run is over, or someone else
 * took it over and this artefact lost the race (Ф2). */
const TERMINAL: ReadonlySet<string> = new Set([
  "applied",
  "cancelled",
  "failed",
  "needs-reconciliation",
]);

interface SnapshotPolicy {
  opsSubset?: ReadonlySet<ApplyOp>;
  caps?: { deletePerRun: number; rewritePerRun: number };
}

/** Policy from the pinned contract snapshot; undefined fields mean the
 * snapshot carries none and the caller's stay in force. */
function policyFromSnapshot(contractJson: string): SnapshotPolicy {
  try {
    const parsed = JSON.parse(contractJson) as {
      policy?: {
        opsSubset?: string[];
        caps?: { deletePerRun: number; rewritePerRun: number };
      };
    };
    const ops = parsed.policy?.opsSubset;
    return {
      opsSubset: Array.isArray(ops) ? new Set(ops as ApplyOp[]) : undefined,
      caps: parsed.policy?.caps,
    };
  } catch {
    return {};
  }
}

/**
 * The candidate half of the gate: the artefact being applied must be the one
 * a critic approved for THIS run. Without it a caller with a valid runId can
 * apply any diff it likes — the run record proves a critic ran, not what the
 * critic looked at.
 *
 * `reviewed` is written only on approval (critic-stage.ts), so the state is
 * the approval; the digest ties the approval to these exact bytes.
 */
function assertApprovedCandidate(
  deps: ApplyExecutorDeps,
  row: RunRow,
  candidate: unknown,
  enforce: boolean,
): void {
  const refuse = (why: string): void => {
    if (!enforce) {
      deps.logger.warn?.(
        `[memory/apply] candidate gate SHADOW (would refuse in enforce) ` +
          `run=${row.runId}: ${why}`,
      );
      return;
    }
    throw new ApplyValidationError(`apply refused: ${why}`);
  };

  if (row.state !== "reviewed") {
    refuse(`run "${row.runId}" is ${row.state}, not reviewed by a critic`);
    return;
  }
  if (
    row.candidateDigest === null ||
    row.verdictDigest === null ||
    row.criticReceipt === null
  ) {
    refuse(`run "${row.runId}" carries no critic receipt`);
    return;
  }
  const applied = digestOf(JSON.stringify(candidate ?? null));
  if (applied !== row.candidateDigest) {
    refuse(
      `the diff is not the approved candidate ` +
        `(applying ${applied.slice(0, 12)}…, approved ${row.candidateDigest.slice(0, 12)}…)`,
    );
  }
}

export function resolveRunPolicy(
  deps: ApplyExecutorDeps,
  run: RunContext | undefined,
  candidate: unknown,
): RunContext | undefined {
  const dataDir = deps.dataDir;
  if (deps.runRepo !== true) return run;
  if (run?.runId === undefined || run.runId === "") {
    throw new ApplyValidationError(
      "apply without runId is refused (memory.consolidation.applyRunRepo)",
    );
  }
  const row = readRun(dataDir, run.runId);
  if (row === null) {
    throw new ApplyValidationError(
      `apply refused: run "${run.runId}" has no control-plane record`,
    );
  }
  if (TERMINAL.has(row.state)) {
    throw new ApplyValidationError(
      `apply refused: run "${run.runId}" is ${row.state}`,
    );
  }
  const enforce = (run.gateMode ?? "shadow") === "enforce";
  assertApprovedCandidate(deps, row, candidate, enforce);

  const snapshot = policyFromSnapshot(row.contractJson);
  // Fail-closed: a snapshot without a policy is a snapshot that cannot bound
  // anything, and falling back to the caller's policy hands the bound to the
  // party being bounded.
  if (
    enforce &&
    (snapshot.opsSubset === undefined || snapshot.caps === undefined)
  ) {
    throw new ApplyValidationError(
      `apply refused: run "${run.runId}" pinned no ops/caps policy`,
    );
  }
  return {
    ...run,
    // The journal's operation ids come from the RECORD, not from the caller:
    // a caller-chosen digest could collide a replay onto this run's journal.
    candidateDigest: row.candidateDigest ?? run.candidateDigest,
    opsSubset: snapshot.opsSubset ?? run.opsSubset,
    caps: snapshot.caps ?? run.caps,
  };
}
