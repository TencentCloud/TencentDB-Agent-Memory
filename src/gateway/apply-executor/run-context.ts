/**
 * Role-scoped apply policy (tz-09 Ф3) — the second argument of `apply()`.
 *
 * The request body says WHAT to change; this says what this run is ALLOWED to
 * change. Keeping it out of the body is deliberate: `applyRequestSchema` is a
 * strict object and, more importantly, a policy that travels inside the
 * payload is a policy the payload's author can rewrite.
 *
 * Ф6 fills this from the control plane by `runId`. Until then a caller may
 * pass it directly, and a caller that passes nothing gets the pre-tz-09
 * behaviour.
 */
import type { ApplyOp } from "./schemas.js";

/** `shadow` logs the divergence and lets the apply through; `enforce` refuses
 * before any mutation. Default is shadow: the gates ship dark, and switching
 * them on is an operator decision (tz-09 R1). */
export type GateMode = "shadow" | "enforce";

export interface RunContext {
  runId?: string;
  /** Digest of the candidate being applied — half of the operation id, so a
   * replay of a DIFFERENT candidate can never collide with this run's
   * journal (tz-09 Ф5). */
  candidateDigest?: string;
  /** Ops this role may perform. Absent → no ops gate (pre-tz-09). */
  opsSubset?: ReadonlySet<ApplyOp>;
  /** Mechanical per-run budgets. Absent → no caps gate. */
  caps?: { deletePerRun: number; rewritePerRun: number };
  gateMode?: GateMode;
  /** Does THIS apply end the run? A role run applies once per batch, and the
   * night loop runs several batches under one Run: closing the run on the
   * first successful apply made every later batch's artefact refusable
   * (`run is applied: artefact refused`, fence.ts:15) and threw away the work
   * of the batches that had already landed. For a run driven by a role the
   * closing state belongs to the run's own finalization (run-outcome.ts);
   * a direct apply that names a run has nothing else to close it, so the
   * default stays true. */
  closesRun?: boolean;
}

export interface CapCounts {
  deletes: number;
  rewrites: number;
}

/** Count what the diff would spend. Merge members are deletes: a merge
 * removes every cluster member except the target (apply-ops-merge.ts:67). */
export function countCapUsage(diff: {
  deleteL1?: unknown[];
  merge?: Array<{ cluster?: unknown[]; target?: string }>;
  rewriteBlock?: unknown[];
  rewriteRecord?: unknown[];
  rewritePersona?: string;
}): CapCounts {
  const mergeMembers = (diff.merge ?? []).reduce(
    (acc, m) => acc + Math.max(0, (m.cluster?.length ?? 0) - 1),
    0,
  );
  return {
    deletes: (diff.deleteL1?.length ?? 0) + mergeMembers,
    rewrites:
      (diff.rewriteBlock?.length ?? 0) +
      (diff.rewriteRecord?.length ?? 0) +
      (diff.rewritePersona === undefined ? 0 : 1),
  };
}
