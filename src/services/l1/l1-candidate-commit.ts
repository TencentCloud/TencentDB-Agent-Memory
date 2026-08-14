import { deriveL1RecordId } from "../../core/record/l1-agent-codec.js";
import type { L1CandidateV1, L1WorksetV1 } from "../../core/record/l1-agent-types.js";
import type { L1ConflictSnapshot } from "../../core/record/l1-conflict-candidates.js";
import { readMemoryRecords } from "../../core/record/l1-reader.js";
import { writeMemory } from "../../core/record/l1-writer.js";
import type { EmbeddingService } from "../../core/store/embedding.js";
import type { IMemoryStore } from "../../core/store/types.js";
import type { Logger } from "../../core/types.js";
import { L1AgentPersistenceError } from "../../core/record/l1-agent-errors.js";
import {
  recordL1CommitOperation,
  verifyL1CommitOperation,
  wasL1CommitOperationStarted,
} from "./l1-commit-journal.js";
import { assertL1TargetPreconditions } from "./l1-target-preconditions.js";
import { assertSameL1Candidate, repairL1Vector } from "./l1-record-repair.js";

export interface L1CommitResult {
  storedCount: number;
  lastSceneName?: string;
}

interface L1CommitInput {
  baseDir: string;
  workset: L1WorksetV1;
  candidate: L1CandidateV1;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  logger?: Logger;
  journal?: { runId: string; candidateDigest: string };
  targetSnapshots: L1ConflictSnapshot[];
  assertLease?: () => void;
}

export async function commitL1Candidate(
  input: L1CommitInput,
): Promise<L1CommitResult> {
  if (!input.vectorStore)
    throw new L1AgentPersistenceError("L1 retrieval store is unavailable");
  const existing = await readMemoryRecords(
    input.workset.sessionKey,
    input.baseDir,
    input.logger,
  );
  const recordsById = new Map(existing.map((record) => [record.id, record]));
  const actionable = input.candidate.scenes.flatMap(({ memories }) =>
    memories.filter(({ action }) => action !== "skip"),
  );
  const operationIds = actionable.map((memory, index) => {
    input.assertLease?.();
    return recordL1CommitOperation(
      input, memory, index, "planned", input.targetSnapshots,
    );
  });
  let storedCount = 0;
  let operationIndex = 0;
  for (const scene of input.candidate.scenes) {
    for (const memory of scene.memories) {
      if (memory.action === "skip") continue;
      input.assertLease?.();
      const currentIndex = operationIndex++;
      const wasStarted = wasL1CommitOperationStarted(
        input,
        operationIds[currentIndex],
      );
      const id = deriveL1RecordId(
        input.workset.assignmentId,
        memory.candidateId,
      );
      const prior = recordsById.get(id);
      if (prior) {
        assertSameL1Candidate(prior, memory);
        await repairL1Vector(
          prior, input.vectorStore, input.embeddingService, input.assertLease,
        );
        input.assertLease?.();
        recordL1CommitOperation(input, memory, currentIndex, "applied", input.targetSnapshots);
        input.assertLease?.();
        await verifyL1CommitOperation(input, operationIds[currentIndex], {
          record: prior,
          targetIds: memory.targetIds,
          vectorStore: input.vectorStore,
        });
        continue;
      }
      await assertL1TargetPreconditions({
        memory,
        snapshots: input.targetSnapshots,
        vectorStore: input.vectorStore,
        allowMissing: wasStarted,
      });
      input.assertLease?.();
      recordL1CommitOperation(input, memory, currentIndex, "prepared", input.targetSnapshots);
      input.assertLease?.();
      const record = await writeMemory({
        memory: {
          content: memory.content,
          type: memory.type,
          priority: memory.priority,
          source_message_ids: memory.sourceMessageIds,
          metadata: memory.metadata,
          scene_name: scene.name,
          scope: memory.scope,
        },
        decision: {
          record_id: id,
          action: memory.action,
          target_ids: memory.targetIds,
        },
        baseDir: input.baseDir,
        sessionKey: input.workset.sessionKey,
        sessionId: input.workset.sessionId,
        projectId: input.workset.projectId,
        logger: input.logger,
        vectorStore: input.vectorStore,
        embeddingService: input.embeddingService,
        provenance: {
          role: "l1-extractor",
          action: memory.action,
          source: "user-input",
        },
        strictVectorWrites: true,
        assertWriteLease: input.assertLease,
      });
      if (record) {
        input.assertLease?.();
        await repairL1Vector(
          record,
          input.vectorStore,
          input.embeddingService,
          input.assertLease,
        );
        recordsById.set(id, record);
        storedCount += 1;
      } else throw new Error(`failed to write deterministic record ${id}`);
      input.assertLease?.();
      recordL1CommitOperation(input, memory, currentIndex, "applied", input.targetSnapshots);
      input.assertLease?.();
      await verifyL1CommitOperation(input, operationIds[currentIndex], {
        record,
        targetIds: memory.targetIds,
        vectorStore: input.vectorStore,
      });
    }
  }
  return {
    storedCount,
    lastSceneName: input.candidate.scenes.at(-1)?.name,
  };
}
