/**
 * L1 Memory Writer: commits extracted memories and their change ledger.
 *
 * File naming: records/YYYY-MM-DD.jsonl (daily shards, all sessions merged).
 * Each record includes sessionKey for traceability.
 *
 * Write strategy:
 * - The memory store owns content and history; SQLite/Mongo commit both atomically.
 * - JSONL is a post-commit mirror, not an independent write mode or complete backup.
 * - On update/merge, old records are deleted from the memory store;
 *   JSONL is append-only and cleaned up periodically by memory-cleaner.
 *
 * Supports store (append), update, merge, and skip operations.
 *
 * v3: Aligned with Kenty's prompt output format — 3 memory types (persona/episodic/instruction),
 * numeric priority, scene_name, source_message_ids, metadata, timestamps.
 */

import crypto from "node:crypto";
import { assertClearGuard, runAsync } from "../store/review.js";
import { DEFAULT_ISOLATION_ID, type IMemoryStore, type L1RecordRow, type MemoryEvent, type MaybePromise } from "../store/types.js";
import { healIsoId, withMemoryEventId } from "../store/memory-event-id.js";
import type { EmbeddingService } from "../store/embedding.js";
import { StorageAdapter } from "../storage/adapter.js";
import { LocalStorageBackend } from "../storage/local-backend.js";
import { StoragePaths } from "../storage/types.js";
import { appendLedgerEvent } from "./event-ledger.js";
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
  /** Monotonic version. New memories start at 0; update/merge = max(target versions)+1. */
  version?: number;
  review_sources?: string[];
  review_guard_at?: string;
  review_epoch?: number;
  expected_existing?: boolean;
  review_status?: import("../store/visibility.js").ReviewStatus;
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
  vectorStore?: IMemoryStore;
  /** Optional embedding service; failures permit metadata + FTS writes. */
  embeddingService?: EmbeddingService;
  /** Storage mirror; standalone callers use a LocalStorageBackend at baseDir. */
  storage?: StorageAdapter;
  startedAt?: string;
  reviewEpoch?: number;
}): Promise<MemoryRecord | null> {
  const { memory, decision, baseDir, sessionKey, sessionId, taskId, teamId, userId, agentId, logger, vectorStore: store, embeddingService } = params;
  if (decision.action === "skip") return null;
  if (!store?.appendMemoryEvent || !store.queryMemoryEvents) {
    logger?.warn?.(`${TAG} Write refused: authoritative memory store and ledger required`);
    return null;
  }
  const now = new Date().toISOString();
  const reviewEpoch = params.reviewEpoch ?? (store.getClearEpoch ? await store.getClearEpoch({ teamId, agentId }) : undefined);
  if (params.startedAt && params.reviewEpoch === undefined && (reviewEpoch ?? 0) > 0) throw new Error("A generation started before its epoch was captured; retry extraction");
  const replacing = decision.action === "merge" || decision.action === "update";
  const content = replacing ? decision.merged_content ?? memory.content : memory.content;
  let embedding: Float32Array | undefined;
  if (embeddingService) {
    try { embedding = await embeddingService.embed(content); }
    catch { logger?.warn?.(`${TAG} Embedding failed; writing metadata + FTS only`); }
  }
  const id = decision.record_id || generateMemoryId();
  const filter = teamId || userId || agentId || taskId ? { teamId, userId, agentId, taskId } : sessionId ? { sessionId } : undefined;
  function* commit(): Generator<MaybePromise<unknown>, { record: MemoryRecord; events: MemoryEvent[] }, unknown> {
    const targets = replacing && decision.target_ids.length
      ? (yield store!.queryL1Records({ ...filter, recordIds: decision.target_ids, visibility: "all" })) as L1RecordRow[] : [];
    if (targets.some((row) => row.review_status === "quarantined")) throw new Error("Dedup target is quarantined");
    const found = new Set(targets.map((row) => row.record_id));
    const missing = replacing ? decision.target_ids.filter((target) => !found.has(target)) : [];
    if (missing.length && ((yield store!.queryMemoryEvents!({ record_ids: missing,
      team_id: healIsoId(teamId ?? ""), user_id: healIsoId(userId ?? ""), agent_id: healIsoId(agentId ?? ""),
      limit: 1, metadata_only: true,
    })) as MemoryEvent[]).length) throw new Error("Dedup target was retired; retry extraction");
    const record: MemoryRecord = {
      id, content, type: replacing ? decision.merged_type ?? memory.type : memory.type,
      priority: replacing ? decision.merged_priority ?? memory.priority : memory.priority,
      scene_name: memory.scene_name, source_message_ids: memory.source_message_ids, metadata: memory.metadata,
      timestamps: replacing ? decision.merged_timestamps ?? [now] : [now], createdAt: now, updatedAt: now,
      version: targets.length ? Math.max(...targets.map((row) => row.version ?? 0)) + 1 : replacing ? 1 : 0,
      review_sources: [...new Set(targets.map((row) => row.record_id).filter((target) => target !== id))],
      review_guard_at: params.startedAt ?? now, review_epoch: reviewEpoch,
      sessionKey, sessionId: sessionId || DEFAULT_ISOLATION_ID, taskId,
      teamId: healIsoId(teamId ?? ""), userId: healIsoId(userId ?? ""), agentId: healIsoId(agentId ?? ""),
    };
    if (!(yield store!.upsertL1(record, embedding))) throw new Error("Successor write refused");
    const deleted = targets.map((row) => row.record_id).filter((target) => target !== id);
    if (deleted.length && !(yield store!.deleteL1Batch(deleted, filter))) throw new Error("Target deletion refused");
    const base = {
      event_ts: now, session_key: sessionKey, session_id: record.sessionId,
      team_id: record.teamId, user_id: record.userId, agent_id: record.agentId, task_id: taskId,
      source: "extraction" as const, layer: "l1" as const,
      review: { protocol: 2 as const, sources: record.review_sources, guard_at: record.review_guard_at, guard_epoch: record.review_epoch },
    };
    const events: MemoryEvent[] = targets.map((old) => withMemoryEventId({
      ...base, op: "superseded", record_id: old.record_id, content: old.content, memory_type: old.type, version: old.version,
      origin_session_id: old.session_id || undefined, origin_session_key: old.session_key || undefined,
      superseded_by: id, snapshot_json: JSON.stringify(old),
    }));
    events.push(withMemoryEventId({
      ...base, op: replacing ? decision.action === "merge" ? "merged" : "updated" : "created",
      record_id: id, content, memory_type: record.type, version: record.version,
      ...(replacing ? { supersedes: targets.map((row) => row.record_id) } : {}),
    }));
    for (const event of events) yield store!.appendMemoryEvent!(event);
    return { record, events };
  }
  let committed: { record: MemoryRecord; events: MemoryEvent[] };
  try {
    committed = store.executeMemoryTransaction ? await store.executeMemoryTransaction(commit) : await runAsync(commit());
  } catch {
    logger?.warn?.(`${TAG} Write could not be confirmed id=${id}; no mirror published`);
    return null;
  }
  try { await assertClearGuard(store, committed.record); }
  catch { logger?.warn?.(`${TAG} Committed generation is no longer verifiable; mirror skipped id=${id}`); return committed.record; }
  const storage = params.storage ?? new StorageAdapter(new LocalStorageBackend({ rootDir: baseDir }));
  try { await storage.appendFile(StoragePaths.record(formatLocalDate(new Date(now))), JSON.stringify(committed.record) + "\n"); }
  catch { logger?.warn?.(`${TAG} Committed record mirror failed id=${id}`); }
  for (const event of committed.events) await appendLedgerEvent({ store, storage, logger, event, storeAlreadyCommitted: true });
  return committed.record;
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
