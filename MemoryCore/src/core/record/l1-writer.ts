/**
 * L1 Memory Writer: writes extracted memories to JSONL files.
 *
 * File naming: records/YYYY-MM-DD.jsonl (daily shards, all sessions merged).
 * Each record includes sessionKey for traceability.
 *
 * Write strategy:
 * - JSONL is the append-only persistent store (source of truth for backup/recovery).
 * - VectorStore (SQLite) is the primary retrieval engine.
 * - On update/merge, old records are deleted from VectorStore in real-time;
 *   JSONL is append-only and cleaned up periodically by memory-cleaner.
 *
 * Supports store (append), update, merge, and skip operations.
 *
 * v3: Aligned with Kenty's prompt output format — 3 memory types (persona/episodic/instruction),
 * numeric priority, scene_name, source_message_ids, metadata, timestamps.
 */

import crypto from "node:crypto";
import { DEFAULT_ISOLATION_ID, type IMemoryStore } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { StoragePaths } from "../storage/types.js";
import type { Logger } from "../types.js";

// ============================
// Types
// ============================

/** L1 memory types: chat-mode legacy types + code/work-mode team memory types. */
export type MemoryType =
  | "persona"
  | "episodic"
  | "instruction"
  | "work_fact"
  | "work_task"
  | "work_method"
  | "work_artifact";

/** Metadata for episodic memories (activity time range) */
export interface EpisodicMetadata {
  activity_start_time?: string; // ISO 8601
  activity_end_time?: string; // ISO 8601
}

/**
 * A persisted memory record in L1 JSONL files.
 *
 * v3 changes from v2:
 * - `importance: "high"|"medium"|"low"` → `priority: number` (0-100, -1 for strict global instructions)
 * - Added `scene_name`, `source_message_ids`, `metadata`, `timestamps`
 * - Removed `keywords` (will be rebuilt from content for search)
 * - MemoryType reduced from 4 to 3 (removed "preference", folded into "persona")
 */
export interface MemoryRecord {
  /** Unique ID for dedup updates */
  id: string;
  /** Memory content */
  content: string;
  /** Memory type: persona / episodic / instruction */
  type: MemoryType;
  /** Priority score: 0-100 (higher = more important), -1 = strict global instruction */
  priority: number;
  /** Scene name this memory belongs to */
  scene_name: string;
  /** Source message IDs that contributed to this memory */
  source_message_ids: string[];
  /** Type-specific metadata (e.g., activity_start_time for episodic) */
  metadata: EpisodicMetadata | Record<string, never>;
  /** Timestamp trail: all timestamps related to this memory (for merge history tracking) */
  timestamps: string[];
  /** Creation timestamp (ISO) */
  createdAt: string;
  /** Last update timestamp (ISO) */
  updatedAt: string;
  /** Monotonic version. New memories start at 1; update/merge increments by 1. */
  version?: number;
  /** Source session key (conversation channel identifier) */
  sessionKey: string;
  /** Source session ID (single conversation instance identifier) */
  sessionId: string;
  /** Optional task dimension for L0/L1 filtering. */
  taskId?: string;
  /**
   * Three-dim tenancy isolation (new in this branch).
   *
   * `userId` / `agentId` are mandatory for new writes once gateway-level
   * isolation enforcement is on, but kept optional on the type to avoid
   * breaking pre-isolation call sites and tests during rollout. The SQLite
   * upsert defaults them to '' if missing; the migration script backfills
   * existing rows with `__legacy__`.
   *
   * See `docs/l0l3-tenant-isolation-design.md`.
   */
  teamId?: string;
  userId?: string;
  agentId?: string;
}

/**
 * A memory as extracted by LLM (before dedup / persistence).
 * Matches the output format of Kenty's extraction prompt.
 */
export interface ExtractedMemory {
  content: string;
  type: MemoryType;
  priority: number;
  source_message_ids: string[];
  metadata: EpisodicMetadata | Record<string, never>;
  /** Scene name this memory was extracted in */
  scene_name: string;
  /**
   * When the underlying conversation happened (ISO 8601 UTC), resolved from
   * the L0 messages this memory cites — NOT when L1 ran. Lets L1 dedup and
   * L2 tell genuinely newer facts from late-arriving older ones when the
   * pipeline processes backlog out of order. Absent for legacy callers; the
   * writer then falls back to the write time (previous behaviour).
   */
  event_time?: string;
}

/** Latest valid ISO timestamp in a memory's timeline (normalised to UTC ISO), or undefined. */
export function latestTimestamp(timestamps: readonly string[] | undefined): string | undefined {
  let best: number | undefined;
  for (const ts of timestamps ?? []) {
    const t = Date.parse(ts);
    if (Number.isFinite(t) && (best === undefined || t > best)) best = t;
  }
  return best === undefined ? undefined : new Date(best).toISOString();
}

/**
 * Timestamps of a merged/updated memory = union of the new memory's event
 * time and every target's stored timestamps, sorted and de-duplicated.
 *
 * Computed in code: the LLM-supplied `merged_timestamps` is only used as a
 * fallback when no target timestamps could be read, and even then only values
 * that parse as real dates are kept (models occasionally invent them).
 */
export function mergeEventTimestamps(
  eventTime: string,
  targetTimestamps: readonly string[],
  llmTimestamps?: readonly string[],
): string[] {
  const valid = (ts: string) => Number.isFinite(Date.parse(ts));
  const pool = [eventTime, ...targetTimestamps];
  if (targetTimestamps.length === 0 && llmTimestamps) pool.push(...llmTimestamps);
  return [...new Set(pool.filter((ts) => ts && valid(ts)).map((ts) => new Date(ts).toISOString()))].sort();
}

/**
 * Resolve the conversation time of one extracted memory.
 *
 * Priority:
 *   1. latest timestamp among its own `source_message_ids` (precise)
 *   2. latest timestamp among its scene's `message_ids` (same scene segment)
 *   3. latest timestamp in the whole batch of new messages
 *
 * Never uses the batch *start/end*: a batch can span several sessions/days,
 * so a span would mislabel a Wednesday memory as Monday. IDs the LLM made up
 * are ignored rather than trusted.
 */
export function resolveMemoryEventTime(
  sourceIds: readonly string[] | undefined,
  sceneIds: readonly string[] | undefined,
  messageTime: ReadonlyMap<string, number>,
): string | undefined {
  const latest = (ids: readonly string[] | undefined): number | undefined => {
    let max: number | undefined;
    for (const id of ids ?? []) {
      const t = messageTime.get(String(id));
      if (typeof t === "number" && Number.isFinite(t) && t > 0 && (max === undefined || t > max)) max = t;
    }
    return max;
  };
  const t = latest(sourceIds) ?? latest(sceneIds) ?? latest([...messageTime.keys()]);
  return t === undefined ? undefined : new Date(t).toISOString();
}

export type DedupAction = "store" | "update" | "merge" | "skip";

/**
 * v3 batch dedup decision — one per new memory, aligned with Kenty's conflict detection prompt.
 *
 * Key changes:
 * - `targetId` → `target_ids` (array, supports multi-target merge/update)
 * - Added `merged_type`, `merged_priority`, `merged_timestamps` for cross-type merge
 */
export interface DedupDecision {
  /** Which new memory this decision is about */
  record_id: string;
  action: DedupAction;
  /** IDs of existing records to replace/remove (for update/merge) */
  target_ids: string[];
  /** Merged/updated content text (for update/merge) */
  merged_content?: string;
  /** Best type after merge (for update/merge, may differ from original) */
  merged_type?: MemoryType;
  /** Priority after merge (for update/merge) */
  merged_priority?: number;
  /** Union of all related timestamps (for update/merge) */
  merged_timestamps?: string[];
}

const TAG = "[memory-tdai][l1-writer]";

// ============================
// Core functions
// ============================

/**
 * Generate a unique memory ID.
 */
export function generateMemoryId(): string {
  return `m_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Write a memory record according to the dedup decision.
 *
 * - store: append new record
 * - update: remove target records + append updated record
 * - merge: remove target records + append merged record
 * - skip: do nothing
 *
 * v3: supports multi-target removal for update/merge.
 * v3.1: optional VectorStore + EmbeddingService for dual-write (JSONL + vector).
 */
export async function writeMemory(params: {
  memory: ExtractedMemory;
  decision: DedupDecision;
  baseDir: string;
  sessionKey: string;
  sessionId?: string;
  taskId?: string;
  /** Tenancy isolation propagated into MemoryRecord and downstream store. */
  teamId?: string;
  userId?: string;
  agentId?: string;
  logger?: Logger;
  /** Optional vector store for dual-write (JSONL + vector DB) */
  vectorStore?: IMemoryStore;
  /** Optional embedding service (required when vectorStore is provided) */
  embeddingService?: EmbeddingService;
  /** StorageAdapter for file operations (COS/local). Falls back to fs when absent. */
  storage?: StorageAdapter;
}): Promise<MemoryRecord | null> {
  const { memory, decision, baseDir, sessionKey, sessionId, taskId, teamId, userId, agentId, logger, vectorStore, embeddingService, storage } = params;

  if (decision.action === "skip") {
    logger?.debug?.(`${TAG} Skipping memory: ${memory.content.slice(0, 50)}...`);
    return null;
  }

  const now = new Date().toISOString();
  // 对话发生时间；旧调用方未提供时退回写入时间（保持原行为）
  const eventTime = memory.event_time || now;

  let nextVersion = 0;
  // merge/update 时，被合并旧记忆的时间戳（由代码取并集，不信任 LLM 回填的 merged_timestamps）
  let targetTimestamps: string[] = [];
  if ((decision.action === "update" || decision.action === "merge") && decision.target_ids.length > 0 && vectorStore) {
    try {
      const existing = await vectorStore.queryL1Records({ recordIds: decision.target_ids });
      const maxVersion = existing.reduce((max, row) => Math.max(max, row.version ?? 0), 0);
      nextVersion = maxVersion + 1;
      for (const row of existing) {
        for (const ts of [row.timestamp_str, row.timestamp_start, row.timestamp_end]) {
          if (ts) targetTimestamps.push(ts);
        }
      }
    } catch (err) {
      logger?.warn?.(`${TAG} Failed to read existing memory version, defaulting to v0: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Determine final content, type, priority based on action
  let finalContent: string;
  let finalType: MemoryType;
  let finalPriority: number;
  let finalTimestamps: string[];

  if (decision.action === "merge" || decision.action === "update") {
    finalContent = decision.merged_content ?? memory.content;
    finalType = decision.merged_type ?? memory.type;
    finalPriority = decision.merged_priority ?? memory.priority;
    finalTimestamps = memory.event_time
      ? mergeEventTimestamps(memory.event_time, targetTimestamps, decision.merged_timestamps)
      // 旧调用方没有对话时间：保持升级前行为（LLM 回填的时间线，缺失时用写入时间）
      : (decision.merged_timestamps ?? [now]);
  } else {
    // store
    finalContent = memory.content;
    finalType = memory.type;
    finalPriority = memory.priority;
    finalTimestamps = [eventTime];
  }

  const record: MemoryRecord = {
    id: decision.record_id || generateMemoryId(),
    content: finalContent,
    type: finalType,
    priority: finalPriority,
    scene_name: memory.scene_name,
    source_message_ids: memory.source_message_ids,
    metadata: memory.metadata,
    timestamps: finalTimestamps,
    createdAt: now,
    updatedAt: now,
    version: nextVersion,
    sessionKey,
    sessionId: sessionId || DEFAULT_ISOLATION_ID,
    taskId,
    teamId,
    // Tenancy isolation — propagated end-to-end so SQLite / TCVDB upsert
    // can persist the row's owner. Empty strings preserve pre-isolation
    // behaviour for callers that haven't been updated yet.
    userId: userId || DEFAULT_ISOLATION_ID,
    agentId: agentId || DEFAULT_ISOLATION_ID,
  };

  const shardDate = formatLocalDate(new Date());
  const recordKey = StoragePaths.record(shardDate);

  // Helper: append a JSONL line
  // - standalone (no storage): write to local fs
  // - service (storage provided): write via StorageAdapter, no fs fallback
  //
  // Guard log (CR-2 fix, 2026-05-19): if storage is absent, emit a warn so any
  // missed wiring (e.g. caller forgot to pass storage in service mode) is
  // immediately visible instead of silently writing to ephemeral pod fs.
  // In standalone mode this warn is benign — the gateway auto-wires a
  // LocalStorageBackend at startup (server.ts:199-203), so storage should
  // normally be defined. Seeing this warn = caller forgot to pass it.
  const appendRecord = async (line: string) => {
    if (storage) {
      await storage.appendFile(recordKey, line);
    } else {
      logger?.warn?.(
        `${TAG} [CR-2 guard] writeMemory called without storage adapter; ` +
        `falling back to local fs at ${baseDir}/records/${shardDate}.jsonl. ` +
        `In service mode this means JSONL is written to ephemeral pod fs and ` +
        `will be lost on restart. Caller must pass 'storage' to writeMemory.`,
      );
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const recordsDir = path.default.join(baseDir, "records");
      await fs.default.mkdir(recordsDir, { recursive: true });
      await fs.default.appendFile(path.default.join(recordsDir, `${shardDate}.jsonl`), line, "utf-8");
    }
  };

  if ((decision.action === "update" || decision.action === "merge") && decision.target_ids.length > 0) {
    // Remove target records from VectorStore (real-time deletion for retrieval accuracy).
    // JSONL is append-only — old records remain in files and are cleaned up periodically
    // by memory-cleaner (which reconciles against VectorStore as source of truth).
    if (vectorStore) {
      try {
        const deleteFilter = teamId || userId || agentId || sessionId
          ? { teamId, userId, agentId, sessionId: sessionId || undefined, sessionKey }
          : undefined;
        if (deleteFilter) {
          await vectorStore.deleteL1Batch(decision.target_ids, deleteFilter);
        } else {
          await vectorStore.deleteL1Batch(decision.target_ids);
        }
        logger?.debug?.(`${TAG} VectorStore: deleted ${decision.target_ids.length} target record(s) for ${decision.action}`);
      } catch (err) {
        logger?.warn?.(
          `${TAG} VectorStore delete failed for ${decision.action}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    try {
      await appendRecord(JSON.stringify(record) + "\n");
    } catch (err) {
      logger?.warn?.(`${TAG} JSONL append failed (non-fatal, VDB write continues): ${err instanceof Error ? err.message : String(err)}`);
    }
    logger?.debug?.(`${TAG} ${decision.action} memory: removed [${decision.target_ids.join(",")}] from VectorStore → ${record.id}: ${finalContent.slice(0, 80)}...`);
  } else {
    // store: append a new line
    try {
      await appendRecord(JSON.stringify(record) + "\n");
    } catch (err) {
      logger?.warn?.(`${TAG} JSONL append failed (non-fatal, VDB write continues): ${err instanceof Error ? err.message : String(err)}`);
    }
    logger?.debug?.(`${TAG} Stored memory ${record.id}: ${finalContent.slice(0, 80)}...`);
  }

  // === Vector Store dual-write ===
  if (vectorStore) {
    try {
      logger?.debug?.(
        `${TAG} [vec-dual-write] START id=${record.id}, contentLen=${record.content.length}, ` +
        `content="${record.content.slice(0, 80)}..."`,
      );

      let embedding: Float32Array | undefined;

      if (embeddingService) {
        try {
          embedding = await embeddingService.embed(record.content);
          logger?.debug?.(
            `${TAG} [vec-dual-write] Embedding OK: dims=${embedding.length}, ` +
            `norm=${Math.sqrt(Array.from(embedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}`,
          );
        } catch (embedErr) {
          // Embedding failed — pass undefined to upsert() which writes
          // metadata + FTS only, skipping the vec0 table.
          logger?.warn(
            `${TAG} [vec-dual-write] Embedding FAILED for id=${record.id}, ` +
            `will write metadata only: ${embedErr instanceof Error ? embedErr.message : String(embedErr)}`,
          );
        }
      }

      const upsertOk = await vectorStore.upsertL1(record, embedding);
      logger?.debug?.(`${TAG} [vec-dual-write] upsert result=${upsertOk} id=${record.id}`);
    } catch (err) {
      // Vector write failure should NOT block the main JSONL write
      logger?.warn?.(
        `${TAG} [vec-dual-write] FAILED (JSONL already written) id=${record.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    logger?.debug?.(
      `${TAG} [vec-dual-write] SKIPPED id=${record.id}: vectorStore=${!!vectorStore}`,
    );
  }

  return record;
}

// ============================
// Helpers
// ============================

function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}