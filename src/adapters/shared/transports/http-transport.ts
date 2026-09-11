/**
 * HTTP Transport — 通过 Gateway REST API 与记忆引擎通信。
 *
 * 复用现有 GatewayClient（含重试 + 熔断器 + jitter），
 * 包装为 MemoryClient 接口，实现参数对象化。
 *
 * 所有平台适配器默认使用此 transport。
 */

import { GatewayClient, GatewayError, type GatewayClientOptions } from "../gateway-client.js";
import {
  MemoryClientError,
  type MemoryClient,
  type MemoryClientStatus,
  type RecallParams,
  type CaptureParams,
  type SearchMemoriesParams,
  type SearchConversationsParams,
  type EndSessionParams,
  type HealthResponse,
  type RecallResponse,
  type CaptureResponse,
  type SearchResponse,
  type SessionEndResponse,
  type HttpTransportOptions,
} from "./types.js";

/**
 * HTTP Transport 实现。
 *
 * 包装 GatewayClient，将参数对象映射到 GatewayClient 的方法签名。
 * 网络/认证/超时错误统一转换为 MemoryClientError。
 *
 * @example
 * ```ts
 * const client = new HttpMemoryClient({ baseUrl: "http://127.0.0.1:8420" });
 * const { context } = await client.recall({ query: "你好", sessionKey: "sess-1" });
 * ```
 */
export class HttpMemoryClient implements MemoryClient {
  private inner: GatewayClient;
  private _closed = false;

  constructor(opts: HttpTransportOptions) {
    const gatewayOpts: GatewayClientOptions = {
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      timeoutMs: opts.timeoutMs,
      retry: opts.retry,
      circuitBreaker: opts.circuitBreaker,
    };
    this.inner = new GatewayClient(gatewayOpts);
  }

  // ============================
  // MemoryClient 实现
  // ============================

  async health(): Promise<HealthResponse> {
    return this.wrap(() => this.inner.health());
  }

  async recall(params: RecallParams): Promise<RecallResponse> {
    return this.wrap(() =>
      this.inner.recall(params.query, params.sessionKey, params.userId),
    );
  }

  async capture(params: CaptureParams): Promise<CaptureResponse> {
    return this.wrap(() =>
      this.inner.capture(
        params.userContent,
        params.assistantContent,
        params.sessionKey,
        params.sessionId,
        params.userId,
      ),
    );
  }

  async searchMemories(params: SearchMemoriesParams): Promise<SearchResponse> {
    return this.wrap(() =>
      this.inner.searchMemories(params.query, params.limit, params.type, params.scene),
    );
  }

  async searchConversations(params: SearchConversationsParams): Promise<SearchResponse> {
    return this.wrap(() =>
      this.inner.searchConversations(params.query, params.limit, params.sessionKey),
    );
  }

  async endSession(params: EndSessionParams): Promise<SessionEndResponse> {
    return this.wrap(() =>
      this.inner.endSession(params.sessionKey, params.userId),
    );
  }

  getStatus(): MemoryClientStatus {
    return {
      transport: "http",
      closed: this._closed,
    };
  }

  /** 暴露熔断器状态（用于监控）。 */
  get circuitState(): string {
    return this.inner.circuitState;
  }

  /** 手动重置熔断器。 */
  resetCircuitBreaker(): void {
    this.inner.resetCircuitBreaker();
  }

  close(): void {
    this._closed = true;
    // GatewayClient 无持久连接，mark closed 即可
  }

  // ============================
  // 内部
  // ============================

  /**
   * 将 GatewayError 转换为 MemoryClientError。
   */
  private wrap<T>(fn: () => Promise<T>): Promise<T> {
    if (this._closed) {
      return Promise.reject(
        new MemoryClientError("Transport 已关闭", "unavailable"),
      );
    }

    return fn().catch((error: unknown) => {
      if (error instanceof MemoryClientError) throw error;

      if (error instanceof GatewayError) {
        throw new MemoryClientError(
          error.message,
          MemoryClientError.codeFromHttpStatus(error.statusCode ?? 0),
          error,
        );
      }

      // 其他未知错误
      const err = error as { message?: string };
      throw new MemoryClientError(
        err.message ?? String(error),
        "transport",
        error,
      );
    });
  }
}
