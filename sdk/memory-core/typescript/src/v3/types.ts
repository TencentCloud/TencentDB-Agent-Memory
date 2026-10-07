import type {
  AtomicDeleteData,
  AtomicDetail,
  AtomicQueryData,
  AtomicSearchData,
  AtomicUpdateData,
  ConversationAddData,
  ConversationDeleteData,
  ConversationItem,
  ConversationQueryData,
  ConversationSearchData,
  CoreFile,
  CoreWriteData,
  CountData,
  ScenarioEntry,
  ScenarioFile,
  ScenarioListData,
  ScenarioWriteData,
} from "../types.js";
import type { MemoryClientConfig, Transport } from "../client.js";

export interface V3MemoryClientConfig extends MemoryClientConfig {
  /** Team ID. Required by v3 strict isolation. */
  teamId: string;
  /** Agent ID. Required by v3 strict isolation. */
  agentId: string;
  /** User ID. Required by v3 strict isolation. */
  userId: string;
  /** Optional default session ID. L0/L1 calls may override it per request. */
  sessionId?: string;
  /** Optional task ID carried in isolation fields. */
  taskId?: string;
  /**
   * 可选的用户 API 密钥，透传为 `x-tdai-user-key` 头。
   *
   * L0–L3 数据面与 `clearChatMemory()` 都**不需要**它 —— 内核不做用户级鉴权。
   * 保留这个可选项是为了与 `MetadataClient` 对齐：当 gateway 前面挂了会校验
   * 用户身份的网关/面板时，可以让请求带上调用方身份。
   */
  userKey?: string;
  reviewerId?: string;
}

export type V3MemoryClientInput = V3MemoryClientConfig | Transport;

export interface V3IsolationContext {
  team_id: string;
  agent_id: string;
  user_id: string;
  session_id?: string;
  task_id?: string;
}

export interface V3IsolationOverrides {
  teamId?: string;
  agentId?: string;
  userId?: string;
  sessionId?: string | null;
  taskId?: string | null;
}

export interface V3ConversationAddRequest {
  session_id?: string;
  messages: ConversationItem[];
}
export type V3ConversationAddData = ConversationAddData;

export interface V3ConversationQueryRequest {
  session_id?: string;
  limit?: number;
  offset?: number;
  time_start?: string;
  time_end?: string;
}
export type V3ConversationQueryData = ConversationQueryData;

export interface V3ConversationSearchRequest {
  query: string;
  limit?: number;
  session_id?: string;
  time_start?: string;
  time_end?: string;
}
export type V3ConversationSearchData = ConversationSearchData;

export interface V3ConversationDeleteRequest {
  /** 待删除的消息 id列表，单次至多 5000 条（自动去重）。 */
  message_ids?: string[];
  /** 待清空的会话 id 列表，单次至多 100 条（自动去重）。 */
  session_ids?: string[];
  /**
   * @deprecated 改用 `session_ids`。保留仅为兼容旧调用方，会被合并进
   * `session_ids`。注意：删除路径**不会**回退到构造函数里的 session_id。
   */
  session_id?: string;
}
export type V3ConversationDeleteData = ConversationDeleteData;
export interface V3ConversationCountRequest {
  session_id?: string;
  time_start?: string;
  time_end?: string;
}

export interface V3AtomicUpdateRequest {
  id: string;
  content: string;
  background?: string;
  session_id?: string;
}
export type V3AtomicUpdateData = AtomicUpdateData;

export interface V3AtomicQueryRequest {
  type?: string;
  limit?: number;
  offset?: number;
  time_start?: string;
  time_end?: string;
  session_id?: string;
}
export type V3AtomicDetail = AtomicDetail;
export type V3AtomicQueryData = AtomicQueryData;

export interface V3AtomicSearchRequest {
  query: string;
  limit?: number;
  type?: string;
  time_start?: string;
  time_end?: string;
  session_id?: string;
}
export type V3AtomicSearchData = AtomicSearchData;

export interface V3AtomicDeleteRequest {
  /** 待删除的 L1 笔记 id 列表，单次至多 5000 条（自动去重）。 */
  ids: string[];
  session_id?: string;
}
export type V3AtomicDeleteData = AtomicDeleteData;

// -- Chat Memory (asset-level) ---------------------------------------------

export interface V3ChatMemoryClearRequest {
  /** 待清空的 chat memory 资产 id 列表，1–100 个（自动去重）。 */
  memory_ids: string[];
}

/** 单个 memory 的清空结果。 */
export interface V3ChatMemoryClearItem {
  memory_id: string;
  /** 是否清空成功。false 时内容可能残留。 */
  cleared: boolean;
  fence_committed?: true;
  fence_commit_unknown?: true;
  counts_verified?: false;
  l0_deleted: number;
  l1_deleted: number;
  /** L2/L3 profile 记录数（VDB 行 + 存储文件）。 */
  profile_deleted: number;
  /** 失败原因；成功时不返回。 */
  reason?: string;
  /**失败是否值得重试（服务端已自动重试过）。 */
  retryable?: boolean;
  /** 服务端实际尝试次数。 */
  attempts?: number;
}

export interface V3ChatMemoryClearData {
  items: V3ChatMemoryClearItem[];
  /** 全部成功时为 true。 */
  all_cleared: boolean;
}

export interface V3AtomicCountRequest {
  type?: string;
  time_start?: string;
  time_end?: string;
  session_id?: string;
}

export interface V3ScenarioListRequest {
  path_prefix?: string;
}
export type V3ScenarioEntry = ScenarioEntry;
export type V3ScenarioListData = ScenarioListData;

export interface V3ScenarioReadRequest {
  path: string;
}
export type V3ScenarioFile = ScenarioFile;

export interface V3ScenarioWriteRequest {
  path: string;
  content: string;
  summary?: string;
}
export type V3ScenarioWriteData = ScenarioWriteData;

export interface V3ScenarioRmRequest {
  path: string;
}

export interface V3ScenarioCountRequest {
  path_prefix?: string;
}

export type V3CoreReadRequest = Record<string, never>;
export type V3CoreFile = CoreFile;

export interface V3CoreWriteRequest {
  content: string;
}
export type V3CoreWriteData = CoreWriteData;
export type V3CountData = CountData;

export interface V3MemoryRevertRequest {
  record_id?: string;
  record_ids?: string[];
  event_id?: string;
  operation_id?: string;
  reason?: string;
  force?: boolean;
}

export interface V3MemoryRevertResult {
  record_id: string;
  reverted: boolean;
  restored?: string[];
  missing?: string[];
  target_event_id?: string;
  operation_id?: string;
  outbox_pending?: boolean;
  status?: number;
  error?: string;
  commit_unknown?: boolean;
}

export type V3MemoryRevertData = V3MemoryRevertResult | { results: V3MemoryRevertResult[]; succeeded: number; failed: number };

export interface V3MemoryReviewRequest {
  record_id?: string;
  record_ids?: string[];
  reason?: string;
  operation_id?: string;
}

export interface V3MemoryReviewData {
  ok: true;
  mode: "retract" | "restore";
  changed: string[];
  no_op: string[];
  not_found: string[];
  event_ids: Record<string, string>;
  operation_id?: string;
  outbox_pending?: true;
  reviewer_attribution: "asserted" | "unattributed";
  downstream?: {
    auto_cleaned: false;
    scan: "complete" | "failed" | "unavailable";
    scope_conservative: true;
    lineage_analyzed: false;
    note: string;
    artifacts: Array<{ layer: "L2" | "L3"; path: string }>;
    truncated?: true;
  };
}

export interface V3MemoryReviewListRequest {
  visibility?: "active" | "quarantined" | "all";
  type?: string;
  time_start?: string;
  time_end?: string;
  limit?: number;
  offset?: number;
}

export interface V3MemoryReviewListData {
  visibility: "active" | "quarantined" | "all";
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
  items: Array<{
    record_id: string; type: string; content: string; review_status: "active" | "quarantined";
    exists: boolean; invalid_status?: true; invalidated_by_clear?: true; invalidated_by_revert?: true; lineage_incomplete?: true;
    session_id: string; version: number; created_at: string; updated_at: string;
  }>;
}

export interface V3DerivedReviewRequest {
  path: string;
  acknowledge?: boolean;
  expected_hash?: string;
  expected_fence?: string;
  reason?: string;
  operation_id?: string;
}

export interface V3DerivedReviewData {
  path: string;
  content_hash: string;
  fence_hash?: string;
  content?: string;
  blocked?: boolean;
  scope_conservative?: true;
  operation_id?: string;
  event_id?: string;
  acknowledged?: true;
  still_blocked?: boolean;
  outbox_pending?: true;
  reviewer_attribution?: "asserted" | "unattributed";
}
