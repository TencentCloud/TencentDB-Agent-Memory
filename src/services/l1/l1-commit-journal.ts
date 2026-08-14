import { createHash } from "node:crypto";
import {
  deriveL1RecordId,
} from "../../core/record/l1-agent-codec.js";
import type {
  L1CandidateMemoryV1,
  L1WorksetV1,
} from "../../core/record/l1-agent-types.js";
import type { L1ConflictSnapshot } from "../../core/record/l1-conflict-candidates.js";
import type { MemoryRecord } from "../../core/record/l1-writer.js";
import type { IMemoryStore } from "../../core/store/types.js";
import {
  listOps,
  markVerified,
  recordOp,
} from "../../gateway/control-plane/oplog.js";
import { assertL1CommitPostconditions } from "./l1-commit-postconditions.js";

export interface L1CommitJournalContext {
  baseDir: string;
  workset: L1WorksetV1;
  journal?: { runId: string; candidateDigest: string };
  assertLease?: () => void;
}

export function recordL1CommitOperation(
  input: L1CommitJournalContext,
  memory: L1CandidateMemoryV1,
  opIndex: number,
  state: "planned" | "prepared" | "applied",
  snapshots: L1ConflictSnapshot[] = [],
): string {
  if (!input.journal) return "";
  input.assertLease?.();
  return recordOp(
    input.baseDir,
    {
      ...input.journal,
      opIndex,
      opType: "storeL1",
      state,
      targetKey: deriveL1RecordId(
        input.workset.assignmentId,
        memory.candidateId,
      ),
      payloadDigest: createHash("sha256").update(memory.content).digest("hex"),
      extraKeys: memory.targetIds,
      action: memory.action,
      beforeDigestJson: JSON.stringify(
        Object.fromEntries(
          (snapshots.find(({ candidateId }) => candidateId === memory.candidateId)
            ?.matches ?? [])
            .filter(({ id }) => memory.targetIds.includes(id))
            .map(({ id, contentDigest }) => [id, contentDigest]),
        ),
      ),
    },
    new Date().toISOString(),
  );
}

export function wasL1CommitOperationStarted(
  input: L1CommitJournalContext,
  operationId: string,
): boolean {
  if (!input.journal || !operationId) return false;
  return listOps(input.baseDir, input.journal.runId).some(
    (row) => row.operationId === operationId && row.state !== "planned",
  );
}

export async function verifyL1CommitOperation(
  input: L1CommitJournalContext,
  operationId: string,
  effect: {
    record: MemoryRecord;
    targetIds: string[];
    vectorStore?: IMemoryStore;
  },
): Promise<void> {
  await assertL1CommitPostconditions({
    baseDir: input.baseDir,
    ...effect,
  });
  if (input.journal && operationId) {
    input.assertLease?.();
    markVerified(input.baseDir, operationId, new Date().toISOString());
  }
}
