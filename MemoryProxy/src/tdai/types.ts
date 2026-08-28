/** TDAI memory integration configuration and shared types. */

export interface TdaiMemoryConfig {
  enabled: boolean;
  /** TDAI Gateway base URL, e.g. http://127.0.0.1:8420 */
  endpoint: string;
  /** Bearer token passed to TDAI Gateway. */
  apiKey: string;
  /** x-tdai-service-id header value. */
  serviceId: string;

  writeL0: boolean;
  recallL1: boolean;
  injectL2L3: boolean;

  l1Limit: number;
  l2Limit: number;
  timeoutMs: number;

  /** 自动召回注入预算（字符数），超出后按相关性截断，防止 prompt 膨胀。 */
  recallCharBudget?: number;
  /** 意图注入模式：keyword / llm / hybrid（默认）。 */
  intentMode?: "keyword" | "llm" | "hybrid";
  /** bypass 会话的 L0 写入策略：skip（默认）/ write-scoped / write。 */
  bypassWritePolicy?: "skip" | "write-scoped" | "write";
  /** bypass 会话的 L1 读取策略：none（默认）/ self-only / default。 */
  bypassReadPolicy?: "none" | "self-only" | "default";
  /** 意图向量检索（教学模板 RAG）：配置后语义层优先用 embedding。 */
  intentEmbedding?: {
    baseUrl: string;
    apiKey: string;
    model: string;
    dimensions: number;
    minScore: number;
    timeoutMs: number;
  };
}

export interface TdaiIdentity {
  teamId: string;
  userId: string;
  agentId: string;
  /** Conversation/session dimension for L0/L1 only. */
  sessionId: string;
    /** Task dimension for L0/L1 only. */
    taskId?: string;
    /** Thread dimension（评审意见 1）：task 之下的主题分组；L0/L1 可选过滤。 */
    threadId?: string;
  /**
   * 请求发起者 user_key（原始 `sk-mem-...`）。用于 tdai `/v3/meta/*` 路由的
   * Layer 3 用户鉴权（`x-tdai-user-key` header）—— ACL 校验路径必须。
   *
   * 数据面（`/v3/conversation/*`）走 team/user/agent header 三元组，不用此字段。
   */
  userKey?: string;
}

/**
 * Per-agent context used when reading other agents' memories
 * (e.g. via the "imported" relation). team/user/agent identify the data
 * owner; sessionId/taskId stay on the *caller* (current request).
 *
 * Why the split: borrowing memories from agent B doesn't change which
 * conversation we're in — L0 captures into the caller's sessionId,
 * but L1 search and L2/L3 reads use B's owning triplet.
 */
export interface TdaiAgentCtx {
  teamId: string;
  userId: string;
  agentId: string;
  /** Display name for prompt section headings ("from X"). */
  agentName?: string;
}

/** Result of L1 recall — keep `from` so proxy can label "[from X]" in prompt. */
export interface TdaiL1Hit extends TdaiL1Memory {
  fromAgentId: string;
  fromAgentName?: string;
}

export interface TdaiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface TdaiL1Memory {
  id: string;
  type?: string;
  content: string;
  score?: number;
  updatedAt?: string;
}

export interface TdaiL2Entry {
  path: string;
  summary?: string;
  updatedAt?: string;
}

export interface TdaiL2File extends TdaiL2Entry {
  content: string;
}

export interface TdaiL3Core {
  content: string;
  updatedAt?: string;
}
