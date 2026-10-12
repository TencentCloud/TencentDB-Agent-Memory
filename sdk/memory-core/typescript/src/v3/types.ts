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
