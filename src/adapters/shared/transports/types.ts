/**
 * Transport 层类型定义 — 统一的 Memory 客户端接口。
 *
 * 将"如何调用 Gateway"从"适配器如何映射平台事件"中解耦。
 * 平台适配器只依赖 `MemoryClient` 接口，不关心底层是 HTTP 还是进程内调用。
 *
 * 设计原则：
 * 1. 接口是合约 — 所有 transport 实现相同的方法签名和语义
 * 2. 错误是结构化的 — 统一的 MemoryClientError 带稳定 code 字段
 * 3. 与现有 GatewayClient API 兼容 — 可平滑迁移
 */

import type {
  HealthResponse,
  RecallResponse,
  CaptureResponse,
  SearchResponse,
  SessionEndResponse,
} from "../gateway-client.js";

// Re-export 已有响应类型以保持向后兼容
export type {
  HealthResponse,
  RecallResponse,
  CaptureResponse,
  SearchResponse,
  SessionEndResponse,
};

// ============================
// Transport 错误模型
// ============================

/** 稳定的机器可读错误码。 */
export type MemoryClientErrorCode =
  | "transport"    // 网络/传输层错误
  | "auth"         // 认证失败
  | "bad_request"  // 请求参数非法
  | "unavailable"  // 服务不可达或已关闭
  | "timeout";     // 请求超时

/**
 * 结构化的 Transport 层错误。
 *
 * 所有 transport 实现必须抛出或拒绝此类型，
 * 适配器层可按 code 字段做细粒度处理。
 */
export class MemoryClientError extends Error {
  constructor(
    message: string,
    public readonly code: MemoryClientErrorCode,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "MemoryClientError";
  }

  /** 从 HTTP 状态码映射到错误码。 */
  static codeFromHttpStatus(status: number): MemoryClientErrorCode {
    if (status === 401 || status === 403) return "auth";
    if (status >= 400 && status < 500) return "bad_request";
    return "transport";
  }
}

// ============================
// Transport 参数类型
// ============================

/** 召回参数。 */
export interface RecallParams {
  query: string;
  sessionKey: string;
  userId?: string;
}

/** 捕获参数。 */
export interface CaptureParams {
  userContent: string;
  assistantContent: string;
  sessionKey: string;
  sessionId?: string;
  userId?: string;
}

/** 搜索记忆参数。 */
export interface SearchMemoriesParams {
  query: string;
  limit?: number;
  type?: string;
  scene?: string;
}

/** 搜索对话参数。 */
export interface SearchConversationsParams {
  query: string;
  limit?: number;
  sessionKey?: string;
}

/** 结束会话参数。 */
export interface EndSessionParams {
  sessionKey: string;
  userId?: string;
}

// ============================
// MemoryClient 接口
// ============================

/**
 * 统一的 Memory 客户端接口。
 *
 * 所有 transport 实现（HTTP、InProcess、Mock）都实现此接口。
 * 平台适配器通过此接口与记忆引擎通信，无需感知底层传输方式。
 *
 * 与现有 `GatewayClient` 的 API 签名兼容。
 */
export interface MemoryClient {
  /** 健康检查。 */
  health(): Promise<HealthResponse>;

  /** 记忆召回。 */
  recall(params: RecallParams): Promise<RecallResponse>;

  /** 对话捕获。 */
  capture(params: CaptureParams): Promise<CaptureResponse>;

  /** 搜索 L1 结构化记忆。 */
  searchMemories(params: SearchMemoriesParams): Promise<SearchResponse>;

  /** 搜索 L0 原始对话。 */
  searchConversations(params: SearchConversationsParams): Promise<SearchResponse>;

  /** 结束会话，触发待处理刷新。 */
  endSession(params: EndSessionParams): Promise<SessionEndResponse>;

  /** 获取传输层当前状态（用于监控）。 */
  getStatus(): MemoryClientStatus;

  /** 关闭 client，释放资源。 */
  close(): Promise<void> | void;
}

/** Transport 状态快照。 */
export interface MemoryClientStatus {
  /** Transport 类型名。 */
  transport: string;
  /** 是否已关闭。 */
  closed: boolean;
}

// ============================
// Transport 工厂配置
// ============================

/** HTTP Transport 配置。 */
export interface HttpTransportOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  /** 重试配置。 */
  retry?: import("../retry.js").RetryOptions;
  /** 熔断器配置。 */
  circuitBreaker?: import("../circuit-breaker.js").CircuitBreakerOptions;
}

/** InProcess Transport 配置。 */
export interface InProcessTransportOptions {
  /** 可注入的 core 实例（测试用）。若未提供则延迟构造自有 core。 */
  core?: unknown;
  /** Gateway 配置路径。 */
  configPath?: string;
  /** 数据目录。 */
  dataDir?: string;
}
