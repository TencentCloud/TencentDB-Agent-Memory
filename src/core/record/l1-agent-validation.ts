import { L1AgentValidationError } from "./l1-agent-errors.js";
import type { L1CandidateV1, L1WorksetV1 } from "./l1-agent-types.js";

export type L1AllowedTargets =
  | ReadonlySet<string>
  | ReadonlyMap<string, ReadonlySet<string>>
  | null;

export function validateL1CandidateReferences(input: {
  candidate: L1CandidateV1;
  workset: L1WorksetV1;
  allowedTargets: L1AllowedTargets;
  maxMemories: number;
}): void {
  const { candidate, workset } = input;
  if (candidate.assignmentId !== workset.assignmentId)
    throw new L1AgentValidationError("candidate assignmentId mismatch");
  if (candidate.inputDigest !== workset.inputDigest)
    throw new L1AgentValidationError("candidate inputDigest mismatch");
  const memories = candidate.scenes.flatMap((scene) => scene.memories);
  if (memories.length > input.maxMemories)
    throw new L1AgentValidationError(
      `candidate memory count ${memories.length} exceeds configured cap ${input.maxMemories}`,
    );
  const sourceIds = new Set(workset.messages.map((message) => message.id));
  const candidateIds = new Set<string>();
  for (const scene of candidate.scenes) {
    assertKnownIds(scene.messageIds, sourceIds, "message");
    for (const memory of scene.memories) {
      if (candidateIds.has(memory.candidateId))
        throw new L1AgentValidationError(
          `duplicate candidate id: ${memory.candidateId}`,
        );
      candidateIds.add(memory.candidateId);
      assertKnownIds(memory.sourceMessageIds, sourceIds, "source");
      const allowed =
        input.allowedTargets instanceof Map
          ? input.allowedTargets.get(memory.candidateId) ?? new Set<string>()
          : input.allowedTargets;
      if (allowed !== null) assertKnownIds(memory.targetIds, allowed, "target");
      if (
        (memory.action === "store" || memory.action === "skip") &&
        memory.targetIds.length > 0
      )
        throw new L1AgentValidationError(
          `${memory.action} candidate must not name targets`,
        );
      if (
        (memory.action === "update" || memory.action === "merge") &&
        memory.targetIds.length === 0
      )
        throw new L1AgentValidationError(
          `${memory.action} candidate requires a reviewed target`,
        );
      if (memory.scope === "project" && workset.projectId === "")
        throw new L1AgentValidationError("project memory requires projectId");
    }
  }
}

function assertKnownIds(
  ids: string[],
  allowed: ReadonlySet<string>,
  kind: "message" | "source" | "target",
): void {
  for (const id of ids)
    if (!allowed.has(id))
      throw new L1AgentValidationError(`unknown ${kind} id: ${id}`);
}
