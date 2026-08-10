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

/** A journal bound to one run + one candidate. */
export function createOpJournal(deps: JournalDeps, counts: OpCounts): OnOp {
  const bases = new Map<OpType, number>();
  return (opType, localIndex, targetKey, phase, payloadDigest) => {
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
      },
      new Date(deps.now()).toISOString(),
    );
  };
}
