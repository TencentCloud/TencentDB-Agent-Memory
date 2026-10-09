/**
 * Gateway HTTP 客户端 — 所有平台适配器的共享通信层。
 *
 * 封装了 Gateway REST API 的所有端点，提供：
 * - 类型安全的请求/响应
 * - 重试（指数退避 + jitter）
 * - 熔断器（防止级联故障）
 * - Bearer Token 认证
 * - 可配置的超时
 */

import { withRetry, type RetryOptions } from "./retry.js";
import { CircuitBreaker, CircuitBreakerOpenError, type CircuitBreakerOptions } from "./circuit-breaker.js";

// ============================
// 类型定义（与 Gateway 协议对齐）
// ============================

export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  uptime: number;
  stores: {
    vectorStore: boolean;
    embeddingService: boolean;
  };
}

export interface RecallResponse {
  context: string;
  strategy?: string;
  memory_count?: number;
}

export interface CaptureResponse {
  l0_recorded: number;
  scheduler_notified: boolean;
}

export interface SearchResponse {
  results: string;
  total: number;
  strategy?: string;
}

export interface SessionEndResponse {
  flushed: boolean;
}

export interface GatewayErrorResponse {
  error: string;
  code?: string;
}

/**
 * Gateway HTTP 请求错误。
 */
export class GatewayError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public errorCode?: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }

  /** 从 HTTP Response 构造 GatewayError。 */
  static async fromResponse(response: Response): Promise<GatewayError> {
    let errorCode: string | undefined;
    let errorMsg = `Gateway 返回 HTTP ${response.status}`;
    try {
      const body = (await response.json()) as GatewayErrorResponse;
      if (body.error) errorMsg = body.error;
      if (body.code) errorCode = body.code;
    } catch {
      // 无法解析 body → 使用默认消息
    }
    return new GatewayError(errorMsg, response.status, errorCode);
  }
}

// ============================
// 客户端配置
// ============================

export interface GatewayClientOptions {
  /** Gateway 基础 URL（如 "http://127.0.0.1:8420"）。 */
  baseUrl: string;
  /** Bearer Token（如已配置）。 */
  apiKey?: string;
  /** 默认请求超时（毫秒），默认 30_000。 */
  timeoutMs?: number;
  /** 重试配置。 */
  retry?: RetryOptions;
  /** 熔断器配置。 */
  circuitBreaker?: CircuitBreakerOptions;
}

// ============================
// GatewayClient
// ============================

/**
 * Gateway HTTP 客户端。
 *
 * 所有平台适配器复用此客户端与 Gateway 通信。
 *
 * @example
 * ```ts
 * const client = new GatewayClient({ baseUrl: "http://127.0.0.1:8420" });
 * const { context } = await client.recall("你好", "sess-1");
 * ```
 */
export class GatewayClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly retryOpts: RetryOptions;
  private readonly breaker: CircuitBreaker;

  constructor(opts: GatewayClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, ""); // 去除尾部斜杠
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.retryOpts = opts.retry ?? {};
    this.breaker = new CircuitBreaker(opts.circuitBreaker);
  }

  // ============================
  // 公共 API 端点
  // ============================

  /** 健康检查。 */
  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/health");
  }

  /** 记忆召回。 */
  async recall(query: string, sessionKey: string, userId?: string): Promise<RecallResponse> {
    return this.request<RecallResponse>("POST", "/recall", {
      query,
      session_key: sessionKey,
      user_id: userId,
    });
  }

  /** 对话捕获。 */
  async capture(
    userContent: string,
    assistantContent: string,
    sessionKey: string,
    sessionId?: string,
    userId?: string,
  ): Promise<CaptureResponse> {
    return this.request<CaptureResponse>("POST", "/capture", {
      user_content: userContent,
      assistant_content: assistantContent,
      session_key: sessionKey,
      session_id: sessionId,
      user_id: userId,
    });
  }

  /** 搜索 L1 结构���记忆。 */
  async searchMemories(
    query: string,
    limit?: number,
    type?: string,
    scene?: string,
  ): Promise<SearchResponse> {
    const body: Record<string, unknown> = { query };
    if (limit != null) body.limit = limit;
    if (type) body.type = type;
    if (scene) body.scene = scene;
    return this.request<SearchResponse>("POST", "/search/memories", body);
  }

  /** 搜索 L0 原始对话。 */
  async searchConversations(
    query: string,
    limit?: number,
    sessionKey?: string,
  ): Promise<SearchResponse> {
    const body: Record<string, unknown> = { query };
    if (limit != null) body.limit = limit;
    if (sessionKey) body.session_key = sessionKey;
    return this.request<SearchResponse>("POST", "/search/conversations", body);
  }

  /** 结束会话并触发刷新。 */
  async endSession(sessionKey: string, userId?: string): Promise<SessionEndResponse> {
    return this.request<SessionEndResponse>("POST", "/session/end", {
      session_key: sessionKey,
      user_id: userId,
    });
  }

  /** 获取熔断器当前状态（用于监控）。 */
  get circuitState(): string {
    return this.breaker.currentState;
  }

  /** 手动重置熔断器。 */
  resetCircuitBreaker(): void {
    this.breaker.reset();
  }

  // ============================
  // 内部方法
  // ============================

  /**
   * 发送 HTTP 请求到 Gateway。
   *
   * 通过熔断器 + 重试器包装，提供韧性保证。
   */
  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const doRequest = async (): Promise<T> => {
      const url = `${this.baseUrl}${path}`;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (this.apiKey) {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        if (!response.ok) {
          throw await GatewayError.fromResponse(response);
        }

        return (await response.json()) as T;
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        if (error instanceof CircuitBreakerOpenError) throw error;
        // 网络错误（包括 AbortError）包装为 GatewayError
        const err = error as { name?: string; code?: string; message?: string };
        const isTimeout = err.name === "AbortError" || err.code === "ETIMEDOUT" || err.code === "ECONNREFUSED";
        throw new GatewayError(
          isTimeout ? `Gateway 请求超时: ${err.message ?? err.code ?? "未知"}` : `Gateway 网络错误: ${err.message ?? String(error)}`,
          undefined,
          err.code,
        );
      } finally {
        clearTimeout(timer);
      }
    };

    // 熔断器 → 重试器 包装
    return this.breaker.execute(() => withRetry(doRequest, this.retryOpts));
  }
}
