/**
 * Domain ↔ MongoDB document mappers for the phase-1 memory backend.
 *
 * Documents store every row field verbatim (so doc→row is near 1:1) plus:
 *   - `tokens`: jieba-pre-segmented text for the `$search` whitespace analyzer.
 *   - numeric `*_ms` shadows for range/order queries that the ISO string form
 *     would make awkward.
 *
 * `_id` is the domain primary key (record_id / row_id) — C5: natural upsert &
 * dedup without a secondary unique index.
 */

import { serializeSourceMessageIds } from "../types.js";
import type { MemoryRecord } from "../../record/l1-writer.js";
import type {
  L0Record,
  L0QueryRow,
  L0SearchResult,
  L0FtsResult,
  L1RecordRow,
  L1SearchResult,
  L1FtsResult,
} from "../types.js";
import { DEFAULT_ISOLATION_ID } from "../isolation.js";
import { tokenizeForFts } from "../tokenize.js";

// ── time helpers ──

export function isoToEpochMs(iso: string | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

// ════════════════════════════════════════════════════════
// L0 (raw conversation)
// ════════════════════════════════════════════════════════

export interface L0Doc {
  _id: string;
  session_key: string;
  session_id: string;
  team_id: string;
  task_id: string;
  user_id: string;
  agent_id: string;
  role: string;
  message_text: string;
  tokens: string;
  recorded_at: string;
  recorded_at_ms: number;
  timestamp: number;
}

export function l0RecordToDoc(record: L0Record): L0Doc {
  return {
    _id: record.id,
    session_key: record.sessionKey,
    session_id: record.sessionId || DEFAULT_ISOLATION_ID,
    team_id: record.teamId ?? "",
    task_id: record.taskId ?? "",
    user_id: record.userId || DEFAULT_ISOLATION_ID,
    agent_id: record.agentId || DEFAULT_ISOLATION_ID,
    role: record.role,
    message_text: record.messageText,
    tokens: tokenizeForFts(record.messageText),
    recorded_at: record.recordedAt,
    recorded_at_ms: isoToEpochMs(record.recordedAt),
    timestamp: record.timestamp ?? 0,
  };
}

export function docToL0QueryRow(doc: L0Doc): L0QueryRow {
  return {
    record_id: doc._id,
    session_key: doc.session_key,
    session_id: doc.session_id,
    team_id: doc.team_id ?? "",
    task_id: doc.task_id ?? "",
    user_id: doc.user_id ?? "",
    agent_id: doc.agent_id ?? "",
    role: doc.role,
    message_text: doc.message_text,
    recorded_at: doc.recorded_at,
    timestamp: doc.timestamp ?? 0,
  };
}

export function docToL0SearchResult(doc: L0Doc, score: number): L0SearchResult {
  return { ...docToL0QueryRow(doc), score };
}

export function docToL0FtsResult(doc: L0Doc, score: number): L0FtsResult {
  return { ...docToL0QueryRow(doc), score };
}

// ════════════════════════════════════════════════════════
// L1 (structured atomic memory)
// ════════════════════════════════════════════════════════

export interface L1Doc {
  _id: string;
  content: string;
  tokens: string;
  type: string;
  priority: number;
  scene_name: string;
  team_id: string;
  user_id: string;
  agent_id: string;
  task_id: string;
  session_key: string;
  session_id: string;
  version: number;
  timestamp_str: string;
  timestamp_start: string;
  timestamp_end: string;
  created_time: string;
  updated_time: string;
  updated_time_ms: number;
  metadata_json: string;
  source_message_ids_json?: string;
}

export function l1RecordToDoc(record: MemoryRecord): L1Doc {
  const tsStr = record.timestamps[0] ?? "";
  const tsStart = record.timestamps.length > 0
    ? record.timestamps.reduce((a, b) => (a < b ? a : b)) : tsStr;
  const tsEnd = record.timestamps.length > 0
    ? record.timestamps.reduce((a, b) => (a > b ? a : b)) : tsStr;
  return {
    _id: record.id,
    content: record.content,
    tokens: tokenizeForFts(record.content),
    type: record.type,
    priority: record.priority,
    scene_name: record.scene_name,
    team_id: record.teamId ?? "",
    user_id: record.userId ?? "",
    agent_id: record.agentId ?? "",
    task_id: record.taskId ?? "",
    session_key: record.sessionKey,
    session_id: record.sessionId,
    version: record.version ?? 0,
    timestamp_str: tsStr,
    timestamp_start: tsStart,
    timestamp_end: tsEnd,
    created_time: record.createdAt,
    updated_time: record.updatedAt,
    updated_time_ms: isoToEpochMs(record.updatedAt),
    metadata_json: JSON.stringify(record.metadata ?? {}),
    source_message_ids_json: serializeSourceMessageIds(record.source_message_ids),
  };
}

export function docToL1RecordRow(doc: L1Doc): L1RecordRow {
  return {
    record_id: doc._id,
    content: doc.content,
    type: doc.type,
    priority: doc.priority ?? 0,
    scene_name: doc.scene_name ?? "",
    session_key: doc.session_key ?? "",
    session_id: doc.session_id ?? "",
    team_id: doc.team_id ?? "",
    task_id: doc.task_id ?? "",
    user_id: doc.user_id ?? "",
    agent_id: doc.agent_id ?? "",
    version: doc.version ?? 0,
    timestamp_str: doc.timestamp_str ?? "",
    timestamp_start: doc.timestamp_start ?? "",
    timestamp_end: doc.timestamp_end ?? "",
    created_time: doc.created_time ?? "",
    updated_time: doc.updated_time ?? "",
    metadata_json: doc.metadata_json ?? "{}",
    source_message_ids_json: doc.source_message_ids_json ?? "[]",
  };
}

export function docToL1SearchResult(doc: L1Doc, score: number): L1SearchResult {
  const row = docToL1RecordRow(doc);
  return {
    record_id: row.record_id,
    content: row.content,
    type: row.type,
    priority: row.priority,
    scene_name: row.scene_name,
    score,
    timestamp_str: row.timestamp_str,
    timestamp_start: row.timestamp_start,
    timestamp_end: row.timestamp_end,
    version: row.version,
    session_key: row.session_key,
    session_id: row.session_id,
    team_id: row.team_id,
    task_id: row.task_id,
    user_id: row.user_id,
    agent_id: row.agent_id,
    metadata_json: row.metadata_json,
    source_message_ids_json: row.source_message_ids_json,
  };
}

export function docToL1FtsResult(doc: L1Doc, score: number): L1FtsResult {
  return docToL1SearchResult(doc, score);
}

// ════════════════════════════════════════════════════════
// Isolation → Mongo filter
// ════════════════════════════════════════════════════════

import type { IsolationFilter } from "../isolation.js";

/** Build a plain Mongo find/`$match` filter fragment from an IsolationFilter. */
export function isolationToMatch(filter: IsolationFilter | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!filter) return out;
  if (filter.teamId !== undefined) out.team_id = filter.teamId;
  if (filter.userId !== undefined) out.user_id = filter.userId;
  if (filter.agentId !== undefined) out.agent_id = filter.agentId;
  if (filter.sessionId !== undefined) out.session_id = filter.sessionId;
  if (filter.taskId !== undefined) out.task_id = filter.taskId;
  if (filter.sessionKey !== undefined) out.session_key = filter.sessionKey;
  return out;
}

/**
 * Build `$search.compound.filter` clauses (`equals` on token-typed fields) from
 * an IsolationFilter, so the isolation predicate applies *before* the `$limit`
 * — keeping multi-tenant recall correct (T3).
 */
export function isolationToSearchFilters(
  filter: IsolationFilter | undefined,
): Array<Record<string, unknown>> {
  const clauses: Array<Record<string, unknown>> = [];
  if (!filter) return clauses;
  const push = (path: string, value: string | undefined) => {
    if (value !== undefined) clauses.push({ equals: { path, value } });
  };
  push("team_id", filter.teamId);
  push("user_id", filter.userId);
  push("agent_id", filter.agentId);
  push("session_id", filter.sessionId);
  push("task_id", filter.taskId);
  push("session_key", filter.sessionKey);
  return clauses;
}

/**
 * Convert an FTS5 MATCH expression (as produced by `buildFtsQuery`,
 * e.g. `"用户" OR "喜欢"`) — or plain raw text — into a space-joined token
 * string suitable for the `$search` `text` operator with a whitespace analyzer.
 */
export function ftsQueryToSearchText(ftsQuery: string): string {
  const quoted = [...ftsQuery.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (quoted.length > 0) return quoted.join(" ");
  return ftsQuery.trim();
}
