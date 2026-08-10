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
import type { ApplyOp } from "./schemas.js";
import type { RunContext } from "./run-context.js";

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

export function resolveRunPolicy(
  dataDir: string,
  run: RunContext | undefined,
  runRepo: boolean,
): RunContext | undefined {
  if (!runRepo) return run;
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
  const snapshot = policyFromSnapshot(row.contractJson);
  return {
    ...run,
    opsSubset: snapshot.opsSubset ?? run.opsSubset,
    caps: snapshot.caps ?? run.caps,
  };
}
