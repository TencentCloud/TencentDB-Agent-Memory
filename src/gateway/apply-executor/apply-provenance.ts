/**
 * Shared writeMemory wrapper for merge + rewriteRecord.
 *
 * Both flows preserve created_time (age must not reset) and pass a stable
 * record id; the only difference is decision.action — "merge" vs "update".
 * Extracted to keep apply-ops.ts and rewrite-record.ts within ≤150 lines.
 */

import { writeMemory } from "../../core/record/l1-writer.js";
import type {
  DedupDecision,
  ExtractedMemory,
} from "../../core/record/l1-writer.js";
import { ApplyRuntimeError } from "./errors.js";
import type { ApplyExecutorDeps } from "./apply-executor-deps.js";
import type { MetaRow } from "./types.js";

export async function writeProvenanceRecord(
  deps: ApplyExecutorDeps,
  args: {
    row: MetaRow;
    memory: ExtractedMemory;
    action: "merge" | "update";
    content: string;
    stableId: string;
    label: string;
  },
): Promise<unknown> {
  const { row, memory, action, content, stableId, label } = args;
  const decision: DedupDecision = {
    record_id: stableId,
    action,
    target_ids: [],
    merged_content: content,
    merged_type: memory.type,
    merged_priority: memory.priority,
  };
  let written: unknown;
  try {
    written = await writeMemory({
      memory,
      decision,
      // `memory.metadata` here is the TARGET record's metadata, read straight
      // from metadata_json by the caller — that is the chain, and it must
      // arrive as previous state rather than as incoming content, which
      // writeMemory now strips provenance from.
      previousMetadata: memory.metadata,
      provenance: { role: label, action, source: "role-run" },
      baseDir: deps.dataDir,
      sessionKey: row.session_key,
      sessionId: row.session_id,
      projectId: row.project_id,
      createdAtOverride: row.created_time || undefined,
      logger: deps.logger,
      vectorStore: deps.vectorStore,
      embeddingService: deps.embeddingService,
    } as Parameters<typeof writeMemory>[0]);
  } catch (err) {
    throw new ApplyRuntimeError(
      `writeMemory failed for ${label}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!written) {
    throw new ApplyRuntimeError(`writeMemory returned null for ${label}`);
  }
  return written;
}
