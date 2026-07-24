/**
 * v2 API 请求/响应类型 — 从 01-api-spec.yaml 提取。
 */

// ---------------------------------------------------------------------------
// 公共
// ---------------------------------------------------------------------------

export interface ApiResponseEnvelope<T = unknown> {
  code: number;
  message: string;
  request_id: string;
  data?: T;
}

// ---------------------------------------------------------------------------
// L0 Conversation
// ---------------------------------------------------------------------------

export interface ConversationItem {
  id?: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
}

export interface ConversationAddRequest {
  session_id: string;
  messages: ConversationItem[];
}
export interface ConversationAddData {
  accepted_ids: string[];
  total_count: number;
}

export interface ConversationQueryRequest {
  session_id?: string;
  limit?: number;
  offset?: number;
  time_start?: string;
  time_end?: string;
}
export interface ConversationQueryData {
  messages: ConversationItem[];
  total: number;
}

export interface ConversationSearchRequest {
  query: string;
  limit?: number;
  session_id?: string;
  time_start?: string;
  time_end?: string;
}
export interface ConversationSearchHit extends ConversationItem {
  score: number;
}
export interface ConversationSearchData {
  messages: ConversationSearchHit[];
}

export interface ConversationDeleteRequest {
  message_ids?: string[];
  session_id?: string;
}
export interface ConversationDeleteData {
  deleted_count: number;
}

// ---------------------------------------------------------------------------
// L1 Atomic
// ---------------------------------------------------------------------------

export interface AtomicDetail {
  id: string;
  type: string;
  content: string;
  background?: string;
  created_at: string;
  updated_at: string;
}

export interface AtomicUpdateRequest {
  id: string;
  content: string;
  background?: string;
}
export interface AtomicUpdateData {
  id: string;
  updated_at: string;
}

export interface AtomicQueryRequest {
  type?: string;
  limit?: number;
  offset?: number;
  time_start?: string;
  time_end?: string;
}
export interface AtomicQueryData {
  items: AtomicDetail[];
  total: number;
}

export interface AtomicSearchRequest {
  query: string;
  limit?: number;
  type?: string;
  time_start?: string;
  time_end?: string;
}
export interface AtomicSearchHit extends AtomicDetail {
  score: number;
}
export interface AtomicSearchData {
  items: AtomicSearchHit[];
}

export interface AtomicDeleteRequest {
  ids: string[];
}
export interface AtomicDeleteData {
  deleted_count: number;
}

// ---------------------------------------------------------------------------
// L2 Scenario
// ---------------------------------------------------------------------------

export interface ScenarioListRequest {
  path_prefix?: string;
}
export interface ScenarioEntry {
  path: string;
  summary?: string;
  created_at: string;
  updated_at: string;
}
export interface ScenarioListData {
  entries: ScenarioEntry[];
  total: number;
}

export interface ScenarioReadRequest {
  path: string;
}
export interface ScenarioFile {
  path: string;
  /** File content. `null` if the file does not exist. */
  content: string | null;
  /** ISO timestamp. `null` if the file does not exist. */
  created_at: string | null;
  /** ISO timestamp. `null` if the file does not exist. */
  updated_at: string | null;
}

export interface ScenarioWriteRequest {
  path: string;
  content: string;
  summary?: string;
}
export interface ScenarioWriteData {
  path: string;
  updated_at: string;
}

export interface ScenarioRmRequest {
  path: string;
}

// ---------------------------------------------------------------------------
// L3 Core
// ---------------------------------------------------------------------------

export interface CoreReadRequest {}
export interface CoreFile {
  /** File content. `null` if core memory has not been generated yet. */
  content: string | null;
  /** ISO timestamp. `null` if not available. */
  created_at: string | null;
  /** ISO timestamp. `null` if not available. */
  updated_at: string | null;
}

export interface CoreWriteRequest {
  content: string;
}
export interface CoreWriteData {
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Offload (Compaction + Ingest)
// ---------------------------------------------------------------------------

export interface OffloadToolPair {
  tool_name: string;
  tool_call_id: string;
  params: unknown;
  result: unknown;
  error?: string;
  timestamp: string;
  duration_ms?: number;
}

export interface OffloadRecentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface OffloadIngestRequest {
  session_id: string;
  tool_pairs: OffloadToolPair[];
  prompt?: string;
  recent_messages?: OffloadRecentMessage[];
}

export interface OffloadIngestData {
  accepted: boolean;
}

export interface OffloadCompactRequest {
  session_id: string;
  messages: unknown[];
  ratio: number;
  context_window: number;
  total_tokens: number;
  message_tokens?: number[];
}

export interface OffloadCompactReport {
  resolvedLevel: string;
  originalCount: number;
  compactedCount: number;
  fastPathReplaced: number;
  fastPathDeleted: number;
  mildReplacements: number;
  aggressiveDeleted: number;
  emergencyDeleted: number;
  mmdInjected: number;
}

export interface OffloadCompactData {
  messages: unknown[];
  report: OffloadCompactReport;
}

export interface OffloadReadRefRequest {
  session_id: string;
  result_ref: string;
  query?: string;
  start_line?: number;
  end_line?: number;
  max_tokens?: number;
}

export interface OffloadReadRefData {
  result_ref: string;
  content: string;
  truncated: boolean;
  match_found?: boolean;
}

export interface OffloadQueryMmdRequest {
  session_id: string;
  limit?: number;
}

export interface OffloadMmdFile {
  filename: string;
  content: string;
  version: number;
}

export interface OffloadQueryMmdData {
  mmds: OffloadMmdFile[];
  current_mmd: string | null;
}
