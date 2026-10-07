/**
 * L1 Memory Reader: reads persisted L1 memory records.
 *
 * Consumption uses the authoritative store's review-aware queries.
 * Raw records JSONL is not a review-safe fallback or a complete recovery source.
 */

import type { MemoryRecord, MemoryType, EpisodicMetadata } from "./l1-writer.js";
import type { IMemoryStore, L1RecordRow, L1QueryFilter } from "../store/types.js";

// Re-export types that readers need
export type { MemoryRecord, MemoryType, EpisodicMetadata } from "./l1-writer.js";
export type { L1QueryFilter } from "../store/types.js";
import type { Logger } from "../types.js";

const TAG = "[memory-tdai] [l1-reader]";

// ============================
// Store-based queries
// ============================

/**
 * Query L1 memory records through the configured authoritative store.
 * Review resolution and isolation are owned by its shared store contract.
 */
export async function queryMemoryRecords(
  vectorStore: IMemoryStore | null | undefined,
  filter?: L1QueryFilter,
  logger?: Logger,
): Promise<MemoryRecord[]> {
  if (!vectorStore) {
    logger?.warn(`${TAG} queryMemoryRecords: no VectorStore available`);
    throw new Error("Authoritative memory store unavailable");
  }

  const rows = await vectorStore.queryL1Records(filter);
  return rows.map(rowToMemoryRecord);
}

/**
 * Convert an authoritative row or audited snapshot to a persisted MemoryRecord.
 */
export function rowToMemoryRecord(row: L1RecordRow): MemoryRecord {
  let metadata: EpisodicMetadata | Record<string, never> = {};
  try {
    metadata = JSON.parse(row.metadata_json) as EpisodicMetadata | Record<string, never>;
  } catch {
    // malformed JSON — use empty object
  }

  // Reconstruct timestamps array from timestamp_start / timestamp_end
  const timestamps: string[] = [];
  if (row.timestamp_str) timestamps.push(row.timestamp_str);
  if (row.timestamp_start && row.timestamp_start !== row.timestamp_str) timestamps.push(row.timestamp_start);
  if (row.timestamp_end && row.timestamp_end !== row.timestamp_str && row.timestamp_end !== row.timestamp_start) {
    timestamps.push(row.timestamp_end);
  }

  return {
    id: row.record_id,
    content: row.content,
    type: row.type as MemoryType,
    priority: row.priority,
    scene_name: row.scene_name,
    source_message_ids: [], // not stored in SQLite (vector search doesn't need them)
    metadata,
    timestamps,
    createdAt: row.created_time,
    updatedAt: row.updated_time,
    version: row.version ?? 0,
    review_status: row.review_baseline ?? row.review_status,
    review_sources: JSON.parse(row.review_sources_json ?? "[]") as string[],
    review_guard_at: row.review_guard_at,
    review_epoch: row.review_epoch ?? undefined,
    sessionKey: row.session_key,
    sessionId: row.session_id,
    taskId: row.task_id,
    teamId: row.team_id,
    userId: row.user_id,
    agentId: row.agent_id,
  };
}
