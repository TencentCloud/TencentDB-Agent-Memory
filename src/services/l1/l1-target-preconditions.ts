import { digestL1Artifact } from "../../core/record/l1-agent-codec.js";
import { L1AgentConflictError } from "../../core/record/l1-agent-errors.js";
import type { L1ConflictSnapshot } from "../../core/record/l1-conflict-candidates.js";
import type { L1CandidateMemoryV1 } from "../../core/record/l1-agent-types.js";
import type { IMemoryStore } from "../../core/store/types.js";

export async function assertL1TargetPreconditions(input: {
  memory: L1CandidateMemoryV1;
  snapshots: L1ConflictSnapshot[];
  vectorStore?: IMemoryStore;
  allowMissing: boolean;
}): Promise<void> {
  if (input.memory.action === "store" || input.memory.action === "skip") return;
  if (!input.vectorStore)
    throw new L1AgentConflictError("reviewed target store is unavailable");
  const snapshot = input.snapshots.find(
    ({ candidateId }) => candidateId === input.memory.candidateId,
  );
  const reviewedById = new Map(snapshot?.matches.map((row) => [row.id, row]));
  for (const targetId of input.memory.targetIds) {
    const reviewed = reviewedById.get(targetId);
    if (!reviewed)
      throw new L1AgentConflictError(`target ${targetId} was not reviewed`);
    const current = await input.vectorStore.getL1ById(targetId);
    if (!current && input.allowMissing) continue;
    if (!current)
      throw new L1AgentConflictError(`target ${targetId} disappeared`);
    const scope = current.scope ?? (current.project_id ? "project" : "global");
    if (
      digestL1Artifact(current.content) !== reviewed.contentDigest ||
      current.updated_time !== reviewed.updatedAt ||
      (current.project_id ?? "") !== reviewed.projectId ||
      scope !== reviewed.scope
    )
      throw new L1AgentConflictError(`target ${targetId} changed after review`);
  }
}
