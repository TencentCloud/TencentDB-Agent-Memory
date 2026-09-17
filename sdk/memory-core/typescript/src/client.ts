/**
 * 共享类型定义：`MemoryClientConfig` / `Transport`。
 *
 * v2 版本的 `MemoryClient` 类已移除；本 SDK 只导出 v3 API（严格 isolation）。
 * 这些 interface 保留是因为 `v3/*.ts` 里的 client 会消费它们。
 */

export interface MemoryClientConfig {
  /** Base URL, e.g. `https://memory.tencentyun.com` */
  endpoint: string;
  /** Bearer token */
  apiKey: string;
  /** Memory instance ID (sent via `x-tdai-service-id` header). */
  serviceId: string;
  /** Request timeout in ms (default 30 000). */
  timeout?: number;
  /** Whether to reject invalid TLS certificates. Default: false (self-signed friendly). */
  rejectUnauthorized?: boolean;
}

/**
 * Transport interface for testing — inject a mock that satisfies this.
 */
export interface Transport {
  post<T>(path: string, body?: Record<string, unknown>): Promise<T>;
  /** Optional for backward-compatible custom transports; management clients fall back to POST when absent. */
  get?<T>(path: string, query?: Record<string, unknown>): Promise<T>;
}
