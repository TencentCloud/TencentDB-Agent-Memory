import { digestL1Artifact } from "../../core/record/l1-agent-codec.js";
import { L1AgentConflictError } from "../../core/record/l1-agent-errors.js";
import type { L1CandidateMemoryV1 } from "../../core/record/l1-agent-types.js";
import type { MemoryRecord } from "../../core/record/l1-writer.js";
import type { EmbeddingService } from "../../core/store/embedding.js";
import type { IMemoryStore } from "../../core/store/types.js";

export function assertSameL1Candidate(
  record: MemoryRecord,
  memory: L1CandidateMemoryV1,
): void {
  if (
    digestL1Artifact({
      content: record.content,
      type: record.type,
      priority: record.priority,
      scope: record.scope,
    }) !==
    digestL1Artifact({
      content: memory.content,
      type: memory.type,
      priority: memory.priority,
      scope: memory.scope,
    })
  )
    throw new L1AgentConflictError(`deterministic record ${record.id} drifted`);
}

export async function repairL1Vector(
  record: MemoryRecord,
  store?: IMemoryStore,
  embedding?: EmbeddingService,
  assertLease?: () => void,
): Promise<void> {
  if (!store) return;
  const stored = await store.getL1ById(record.id);
  if (stored?.content === record.content) return;
  const vector = embedding ? await embedding.embed(record.content) : undefined;
  assertLease?.();
  if (!(await store.upsertL1(record, vector)))
    throw new Error(`failed to repair vector record ${record.id}`);
}
