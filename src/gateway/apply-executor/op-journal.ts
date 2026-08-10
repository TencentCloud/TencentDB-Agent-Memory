/**
 * The journal seam for the mutation modules (tz-09 Ф5).
 *
 * The four `apply-ops-*` modules take an optional `onOp` callback and call it
 * `prepared` before a mutation and `applied` after it. They stay ignorant of
 * the control plane: the callback is either a real journal (a run with an id)
 * or a no-op (a direct apply, as in the 37 existing call sites).
 */
import { createHash } from "node:crypto";
import {
  opIndexBase,
  recordOp,
  type OpCounts,
  type OpType,
} from "../control-plane/oplog.js";
import type { ApplyDiff } from "./schemas.js";

export type OpPhase = "prepared" | "applied";

/** Called by a mutation module per operation. `localIndex` is the position
 * inside that op TYPE, not the global order — the journal maps it. */
export type OnOp = (
  opType: OpType,
  localIndex: number,
  targetKey: string,
  phase: OpPhase,
  /** Digest of the content this operation WRITES. Reconciliation compares it
   * against what the store holds now, so "the target exists" is never mistaken
   * for "the operation landed". Deletes have none. */
  payloadDigest?: string,
  /** Other keys the SAME operation must affect — the members a merge deletes.
   * They are part of its postcondition, not separate operations. */
  extraKeys?: string[],
) => void;

/** The one hash the journal and the postconditions share. */
export function digestOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function countOps(diff: ApplyDiff): OpCounts {
  return {
    merge: diff.merge?.length ?? 0,
    rewriteRecord: diff.rewriteRecord?.length ?? 0,
    deleteL1: diff.deleteL1?.length ?? 0,
    rewriteBlock: diff.rewriteBlock?.length ?? 0,
    rewritePersona: diff.rewritePersona === undefined ? 0 : 1,
  };
}

export interface JournalDeps {
  dataDir: string;
  runId: string;
  candidateDigest: string;
  now: () => number;
}

/** Every operation of a diff, in canonical order, as (type, localIndex, key).
 * The key is the RAW one from the candidate; the attempt overwrites it with
 * the resolved path where the two differ (recordOp keeps the non-empty one). */
function planOf(diff: ApplyDiff): Array<[OpType, number, string]> {
  const plan: Array<[OpType, number, string]> = [];
  (diff.merge ?? []).forEach((op, i) => plan.push(["merge", i, op.target]));
  (diff.rewriteRecord ?? []).forEach((op, i) =>
    plan.push(["rewriteRecord", i, op.id]),
  );
  (diff.deleteL1 ?? []).forEach((op, i) => plan.push(["deleteL1", i, op.id]));
  (diff.rewriteBlock ?? []).forEach((op, i) =>
    plan.push(["rewriteBlock", i, op.path]),
  );
  if (diff.rewritePersona !== undefined) {
    plan.push(["rewritePersona", 0, "persona.md"]);
  }
  return plan;
}

/**
 * Write the WHOLE plan before the first mutation.
 *
 * `prepared` used to be the first trace an operation left, so a crash between
 * operations 2 and 3 left nothing saying operation 3 was ever supposed to
 * happen — and reconciliation walks rows, so it could not see the difference.
 */
export function recordPlan(deps: JournalDeps, diff: ApplyDiff): void {
  const counts = countOps(diff);
  const nowIso = new Date(deps.now()).toISOString();
  for (const [opType, localIndex, targetKey] of planOf(diff)) {
    recordOp(
      deps.dataDir,
      {
        runId: deps.runId,
        candidateDigest: deps.candidateDigest,
        opIndex: opIndexBase(counts, opType) + localIndex,
        opType,
        state: "planned",
        targetKey,
      },
      nowIso,
    );
  }
}

/** A journal bound to one run + one candidate. */
export function createOpJournal(deps: JournalDeps, counts: OpCounts): OnOp {
  const bases = new Map<OpType, number>();
  return (opType, localIndex, targetKey, phase, payloadDigest, extraKeys) => {
    let base = bases.get(opType);
    if (base === undefined) {
      base = opIndexBase(counts, opType);
      bases.set(opType, base);
    }
    recordOp(
      deps.dataDir,
      {
        runId: deps.runId,
        candidateDigest: deps.candidateDigest,
        opIndex: base + localIndex,
        opType,
        state: phase,
        targetKey,
        payloadDigest,
        extraKeys,
      },
      new Date(deps.now()).toISOString(),
    );
  };
}
