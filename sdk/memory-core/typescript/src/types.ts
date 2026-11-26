/**
 * v2 API 请求/响应类型 — 从 docs/team-api-仅memory.yaml 提取。
 *
 * 团队记忆契约扩展：在 offload.yaml 13 个接口基础上叠加可选 IdFields
 * (team_id / agent_id / user_id / task_id)，用于服务化模式的身份隔离。
 * 旧客户端不传 IdFields 时按原 offload 语义工作。
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

/**
 * 团队记忆 4 ID 隔离字段，全部可选；接口 schema 层不做必填校验。
 * 服务端 resolveIsolation 优先取 body 字段，缺失时回退 x-tdai-* header。
 *
 * 详见 docs/team-api-仅memory.yaml 中的 IdFields 组件。
 */
export interface IdFields {
  /** 团队 ID（PRD §3.2）。 */
  team_id?: string;
  /** Agent ID（PRD §3.2）；与 team_id 组成复合唯一键。 */
  agent_id?: string;
  /** 用户 ID（PRD §3.2，太湖账号映射）。 */
  user_id?: string;
  /** 任务 ID（PRD §3.2）；归属由 (team_id, task_id) 校验。 */
  task_id?: string;
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

export interface ConversationAddRequest extends IdFields {
  session_id: string;
  messages: ConversationItem[];
}
export interface ConversationAddData {
  accepted_ids: string[];
  total_count: number;
}

export interface ConversationQueryRequest extends IdFields {
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

export interface ConversationSearchRequest extends IdFields {
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

export interface ConversationDeleteRequest extends IdFields {
  message_ids?: string[];
  session_id?: string;
}
export interface ConversationDeleteData {
  deleted_count: number;
}

export interface CountData {
  total: number;
}

export interface ConversationCountRequest extends IdFields {
  session_id?: string;
  time_start?: string;
  time_end?: string;
}

// ---------------------------------------------------------------------------
// L1 Atomic
// ---------------------------------------------------------------------------

export interface AtomicDetail {
  id: string;
  type: string;
  content: string;
  background?: string;
  /** Monotonic L1 version used for compare-and-swap updates. */
  version?: number;
  created_at: string;
  updated_at: string;
}

export interface AtomicUpdateRequest extends IdFields {
  id: string;
  content: string;
  background?: string;
  /** Reject the update with HTTP 409 when the stored version no longer matches. */
  expected_version?: number;
}
export interface AtomicUpdateData {
  id: string;
  /** New monotonic version after a successful update (serialized by the API). */
  version?: string;
  updated_at: string;
}

export interface AtomicQueryRequest extends IdFields {
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

export interface AtomicSearchRequest extends IdFields {
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

export interface AtomicDeleteRequest extends IdFields {
  ids: string[];
}
export interface AtomicDeleteData {
  deleted_count: number;
}

export interface AtomicCountRequest extends IdFields {
  type?: string;
  time_start?: string;
  time_end?: string;
}

// ---------------------------------------------------------------------------
// L2 Scenario
// ---------------------------------------------------------------------------

export interface ScenarioListRequest extends IdFields {
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

export interface ScenarioReadRequest extends IdFields {
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

export interface ScenarioWriteRequest extends IdFields {
  path: string;
  content: string;
  summary?: string;
}
export interface ScenarioWriteData {
  path: string;
  updated_at: string;
}

export interface ScenarioRmRequest extends IdFields {
  path: string;
}

export interface ScenarioCountRequest extends IdFields {
  path_prefix?: string;
}

// ---------------------------------------------------------------------------
// L3 Core
// ---------------------------------------------------------------------------

export interface CoreReadRequest extends IdFields {}
export interface CoreCountRequest extends IdFields {}
export interface CoreFile {
  /** File content. `null` if core memory has not been generated yet. */
  content: string | null;
  /** ISO timestamp. `null` if not available. */
  created_at: string | null;
  /** ISO timestamp. `null` if not available. */
  updated_at: string | null;
}

export interface CoreWriteRequest extends IdFields {
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
