import { ParamError } from "../errors.js";
import { V3HttpTransport } from "./http.js";
import type { Transport } from "../client.js";
import type {
  V3AtomicCountRequest,
  V3AtomicDeleteData,
  V3AtomicDeleteRequest,
  V3AtomicQueryData,
  V3AtomicQueryRequest,
  V3AtomicSearchData,
  V3AtomicSearchRequest,
  V3AtomicUpdateData,
  V3AtomicUpdateRequest,
  V3ChatMemoryClearData,
  V3ChatMemoryClearRequest,
  V3ConversationAddData,
  V3ConversationAddRequest,
  V3ConversationCountRequest,
  V3ConversationDeleteData,
  V3ConversationDeleteRequest,
  V3ConversationQueryData,
  V3ConversationQueryRequest,
  V3ConversationSearchData,
  V3ConversationSearchRequest,
  V3CoreFile,
  V3CoreReadRequest,
  V3CoreWriteData,
  V3CoreWriteRequest,
  V3CountData,
  V3IsolationContext,
  V3IsolationOverrides,
  V3MemoryClientConfig,
  V3ScenarioFile,
  V3ScenarioListData,
  V3ScenarioListRequest,
  V3ScenarioReadRequest,
  V3ScenarioRmRequest,
  V3ScenarioCountRequest,
  V3ScenarioWriteData,
  V3ScenarioWriteRequest,
} from "./types.js";

const V3 = "/v3";

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function requireNonEmpty(name: string, value: string | undefined): string {
  if (!value) throw new ParamError(`v3 MemoryClient requires non-empty ${name}`);
  return value;
}

class IsolationContext {
  constructor(
    readonly teamId: string,
    readonly agentId: string,
    readonly userId: string,
    readonly sessionId?: string,
    readonly taskId?: string,
  ) {
    requireNonEmpty("teamId", teamId);
    requireNonEmpty("agentId", agentId);
    requireNonEmpty("userId", userId);
  }

  baseBody(): V3IsolationContext {
    return stripUndefined({
      team_id: this.teamId,
      agent_id: this.agentId,
      user_id: this.userId,
      task_id: this.taskId,
    }) as unknown as V3IsolationContext;
  }

  resolveSession(override?: string): string | undefined {
    return override ?? this.sessionId;
  }

  /**
   * 写入路径专用：`addConversation` 必须拿到一个非空 session_id。
   * 缺则抛错——避免服务端把无 session 的写入静默合并到默认 bucket，
   * 与其他调用方的数据混在一起。
   */
  resolveSessionForWrite(override?: string): string {
    const sid = override ?? this.sessionId;
    if (!sid) {
      throw new ParamError(
        "v3 MemoryClient.addConversation requires session_id: " +
        "pass it in the constructor or per call. " +
        "Reads (query/search/count) may omit it to aggregate across sessions.",
      );
    }
    return sid;
  }

  with(overrides: V3IsolationOverrides): IsolationContext {
    return new IsolationContext(
      overrides.teamId ?? this.teamId,
      overrides.agentId ?? this.agentId,
      overrides.userId ?? this.userId,
      overrides.sessionId === null ? undefined : overrides.sessionId ?? this.sessionId,
      overrides.taskId === null ? undefined : overrides.taskId ?? this.taskId,
    );
  }
}

/**
 * v3 strict-isolation data-plane client.
 *
 * Constructor requires teamId / agentId / userId. sessionId rules:
 * - `addConversation` (write path) **requires** sessionId — pass in
 *   constructor or per call; missing → throws. This prevents session-less
 *   writes from being silently merged into a default bucket server-side.
 * - Read paths (query / search / count / delete) allow sessionId to be
 *   omitted; the server aggregates across sessions for the same
 *   team+agent+user.
 * - L2/L3 are team+agent profile data and do not consume sessionId.
 */
/**
 * 归一化批量删除的 id 列表：校验非空字符串、去重、检查上限。
 *
 * 破坏性操作的入参在客户端就拦一道，比让服务端回 400 更早暴露问题，
 * 也避免把明显不合法的批量请求发出去。
 *
 * @returns 归一化后的数组；入参为 undefined 时返回 undefined（表示"未提供"）
 */
function normalizeDeleteIds(
  field: string,
  raw: string[] | undefined,
  max: number,
): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new ParamError(`${field} must be an array of non-empty strings`);
  }
  if (raw.some((id) => typeof id !== "string" || !id.trim())) {
    throw new ParamError(`${field} must contain only non-empty strings`);
  }
  const deduped = [...new Set(raw.map((id) => id.trim()))];
  if (deduped.length > max) {
    throw new ParamError(`${field} accepts at most ${max} items, got ${deduped.length}`);
  }
  return deduped;
}

export class MemoryClient {
  private readonly http: Transport;
  private readonly iso: IsolationContext;

  constructor(config: V3MemoryClientConfig);
  constructor(transport: Transport, isolation: V3IsolationContext);
  constructor(configOrTransport: V3MemoryClientConfig | Transport, isolation?: V3IsolationContext) {
    if ("post" in configOrTransport) {
      if (!isolation) throw new ParamError("v3 MemoryClient transport constructor requires isolation context");
      this.http = configOrTransport;
      this.iso = new IsolationContext(
        isolation.team_id,
        isolation.agent_id,
        isolation.user_id,
        isolation.session_id,
        isolation.task_id,
      );
      return;
    }

    const cfg = configOrTransport;
    this.http = new V3HttpTransport({
      endpoint: cfg.endpoint,
      apiKey: cfg.apiKey,
      serviceId: cfg.serviceId,
      // 可选：透传调用方身份。内核不校验，但前置网关/面板可能需要。
      userKey: cfg.userKey,
      timeout: cfg.timeout,
      rejectUnauthorized: cfg.rejectUnauthorized,
    });
    this.iso = new IsolationContext(cfg.teamId, cfg.agentId, cfg.userId, cfg.sessionId, cfg.taskId);
  }

  withIsolation(overrides: V3IsolationOverrides): MemoryClient {
    const next = this.iso.with(overrides);
    return new MemoryClient(this.http, {
      team_id: next.teamId,
      agent_id: next.agentId,
      user_id: next.userId,
      session_id: next.sessionId,
      task_id: next.taskId,
    });
  }

  // -- L0 Conversation ---------------------------------------------------

  addConversation(params: V3ConversationAddRequest): Promise<V3ConversationAddData> {
    return this.http.post(`${V3}/conversation/add`, stripUndefined({
      ...this.iso.baseBody(),
      session_id: this.iso.resolveSessionForWrite(params.session_id),
      messages: params.messages,
    }));
  }

  queryConversation(params: V3ConversationQueryRequest = {}): Promise<V3ConversationQueryData> {
    return this.http.post(`${V3}/conversation/query`, stripUndefined({
      ...this.iso.baseBody(),
      session_id: this.iso.resolveSession(params.session_id),
      limit: params.limit,
      offset: params.offset,
      time_start: params.time_start,
      time_end: params.time_end,
    }));
  }

  searchConversation(params: V3ConversationSearchRequest): Promise<V3ConversationSearchData> {
    return this.http.post(`${V3}/conversation/search`, stripUndefined({
      ...this.iso.baseBody(),
      session_id: this.iso.resolveSession(params.session_id),
      query: params.query,
      limit: params.limit,
      time_start: params.time_start,
      time_end: params.time_end,
    }));
  }

  /**
   * `POST /v3/conversation/delete` — 批量删除 L0。
   *
   * `message_ids`（≤5000）与 `session_ids`（≤100）至少给一个，可同时给。
   *
   * 注意作用域：这里**不会**回退到构造函数里的 `session_id`。删除是破坏性
   * 操作，若像读接口那样自动带上默认 session，只想按 message_ids 删几条的
   * 调用方会意外把整个会话删掉。要删会话必须显式传 `session_ids`。
   */
  deleteConversation(params: V3ConversationDeleteRequest = {}): Promise<V3ConversationDeleteData> {
    const messageIds = normalizeDeleteIds("message_ids", params.message_ids, 5000);
    // 同时接受 session_ids（推荐）与已废弃的单数 session_id，归一成数组。
    const sessionIds = normalizeDeleteIds("session_ids", params.session_ids, 100);
    const legacySingle = params.session_id;
    if (legacySingle !== undefined && !legacySingle) {
      throw new ParamError("session_id must be a non-empty string");
    }
    const mergedSessions = legacySingle
      ? [...new Set([...(sessionIds ?? []), legacySingle])]
      : sessionIds;

    if (!messageIds?.length && !mergedSessions?.length) {
      throw new ParamError(
        "deleteConversation requires message_ids or session_ids " +
        "(the constructor session_id is intentionally NOT used for deletes)",
      );
    }

    return this.http.post(`${V3}/conversation/delete`, stripUndefined({
      ...this.iso.baseBody(),
      message_ids: messageIds,
      session_ids: mergedSessions,
    }));
  }

  countConversation(params: V3ConversationCountRequest = {}): Promise<V3CountData> {
    return this.http.post(`${V3}/conversation/count`, stripUndefined({
      ...this.iso.baseBody(),
      session_id: this.iso.resolveSession(params.session_id),
      time_start: params.time_start,
      time_end: params.time_end,
    }));
  }

  // -- L1 Atomic ---------------------------------------------------------

  updateAtomic(params: V3AtomicUpdateRequest): Promise<V3AtomicUpdateData> {
    return this.http.post(`${V3}/atomic/update`, stripUndefined({
      ...this.iso.baseBody(),
      session_id: this.iso.resolveSession(params.session_id),
      id: params.id,
      content: params.content,
      background: params.background,
    }));
  }

  queryAtomic(params: V3AtomicQueryRequest = {}): Promise<V3AtomicQueryData> {
    return this.http.post(`${V3}/atomic/query`, stripUndefined({
      ...this.iso.baseBody(),
      session_id: this.iso.resolveSession(params.session_id),
      type: params.type,
      limit: params.limit,
      offset: params.offset,
      time_start: params.time_start,
      time_end: params.time_end,
    }));
  }

  searchAtomic(params: V3AtomicSearchRequest): Promise<V3AtomicSearchData> {
    return this.http.post(`${V3}/atomic/search`, stripUndefined({
      ...this.iso.baseBody(),
      session_id: this.iso.resolveSession(params.session_id),
      query: params.query,
      limit: params.limit,
      type: params.type,
      time_start: params.time_start,
      time_end: params.time_end,
    }));
  }

  deleteAtomic(params: V3AtomicDeleteRequest): Promise<V3AtomicDeleteData> {
    //ids 必填，单次至多 5000 条，去重后发送。
    const ids = normalizeDeleteIds("ids", params.ids, 5000);
    if (!ids?.length) {
      throw new ParamError("deleteAtomic requires a non-empty ids list");
    }
    return this.http.post(`${V3}/atomic/delete`, stripUndefined({
      ...this.iso.baseBody(),
      session_id: this.iso.resolveSession(params.session_id),
      ids,
    }));
  }

  countAtomic(params: V3AtomicCountRequest = {}): Promise<V3CountData> {
    return this.http.post(`${V3}/atomic/count`, stripUndefined({
      ...this.iso.baseBody(),
      session_id: this.iso.resolveSession(params.session_id),
      type: params.type,
      time_start: params.time_start,
      time_end: params.time_end,
    }));
  }

  // -- L2 Scenario -------------------------------------------------------

  listScenarios(params: V3ScenarioListRequest = {}): Promise<V3ScenarioListData> {
    return this.http.post(`${V3}/scenario/ls`, stripUndefined({ ...this.iso.baseBody(), path_prefix: params.path_prefix }));
  }

  readScenario(params: V3ScenarioReadRequest): Promise<V3ScenarioFile> {
    return this.http.post(`${V3}/scenario/read`, stripUndefined({ ...this.iso.baseBody(), path: params.path }));
  }

  writeScenario(params: V3ScenarioWriteRequest): Promise<V3ScenarioWriteData> {
    return this.http.post(`${V3}/scenario/write`, stripUndefined({
      ...this.iso.baseBody(),
      path: params.path,
      content: params.content,
      summary: params.summary,
    }));
  }

  rmScenario(params: V3ScenarioRmRequest): Promise<void> {
    return this.http.post(`${V3}/scenario/rm`, stripUndefined({ ...this.iso.baseBody(), path: params.path }));
  }

  countScenario(params: V3ScenarioCountRequest = {}): Promise<V3CountData> {
    return this.http.post(`${V3}/scenario/count`, stripUndefined({ ...this.iso.baseBody(), path_prefix: params.path_prefix }));
  }

  // -- L3 Core ------------------------------------------------------------

  readCore(_params: V3CoreReadRequest = {}): Promise<V3CoreFile> {
    return this.http.post(`${V3}/core/read`, this.iso.baseBody() as unknown as Record<string, unknown>);
  }

  writeCore(params: V3CoreWriteRequest): Promise<V3CoreWriteData> {
    return this.http.post(`${V3}/core/write`, stripUndefined({ ...this.iso.baseBody(), content: params.content }));
  }

  countCore(): Promise<V3CountData> {
    return this.http.post(`${V3}/core/count`, this.iso.baseBody() as unknown as Record<string, unknown>);
  }

  // -- Chat Memory (asset-level) -------------------------------------------

  /**
   * `POST /v3/chat-memory/clear` — 一键清空 chat memory 的**全部内容**，
   * 但保留资产本身。
   *
   * 清空范围：L0 / L1 / L2 / L3 + 向量 + 文件。
   * 保留内容：`memory_id`、Team/Agent 归属、Agent 绑定、ACL、Owner、
   * 名称、可见性 —— 清空后 Agent 继续用原 `memory_id` 写入，无需重建。
   *
   * 与 L0/L1 删除接口不同，本接口是**资产级**操作：
   *   - 作用域由 `memory_ids` 自身决定，不使用隔离三元组
   *   - 任一 `memory_id` 不存在或不是 chat_memory 时**整批拒绝**，一条都不清
   *   - 幂等：已清空过的再次调用仍返回成功，计数为 0
   *
   * 权限：与其它删除接口一致，内核不做用户级鉴权。若需要"仅 Owner 可清空"
   * 的约束，请走面板后端 `/api/v1/chat-memory/clear`（那里会校验 Owner）。
   *
   * 失败项会带 `retryable` 标志；为 true 表示服务端已自动重试仍未成功，
   * 稍后重试即可补齐残留内容。
   */
  clearChatMemory(params: V3ChatMemoryClearRequest): Promise<V3ChatMemoryClearData> {
    const memoryIds = normalizeDeleteIds("memory_ids", params.memory_ids, 100);
    if (!memoryIds?.length) {
      throw new ParamError("clearChatMemory requires a non-empty memory_ids list");
    }
    // 注意：不带隔离三元组 —— 作用域由 memory_ids 决定。
    return this.http.post(`${V3}/chat-memory/clear`, { memory_ids: memoryIds });
  }
}
