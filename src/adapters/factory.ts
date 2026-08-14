/**
 * Adapter Factory — 统一创建 MemoryClient 的工厂函数。
 *
 * 支持通过环境变量选择 transport 类型：
 *   TDAI_ADAPTER_TRANSPORT = "http" | "in-process" (默认 "http")
 *
 * 设计参考 PR #534 的 createMemoryClient()。
 */

import { HttpMemoryClient, InProcessMemoryClient, type MemoryClient } from "./shared/transports/index.js";
import type { HttpTransportOptions, InProcessTransportOptions } from "./shared/transports/types.js";

// ============================
// Transport 判别联合
// ============================

export type TransportConfig =
  | { type: "http"; options: HttpTransportOptions }
  | { type: "in-process"; options?: InProcessTransportOptions };

// ============================
// 工厂函数
// ============================

/**
 * 根据配置创建 MemoryClient 实例。
 *
 * @example
 * ```ts
 * // HTTP transport（默认）
 * const client = createMemoryClient({
 *   type: "http",
 *   options: { baseUrl: "http://127.0.0.1:8420" },
 * });
 *
 * // InProcess transport（测试用）
 * const client = createMemoryClient({
 *   type: "in-process",
 *   options: { core: fakeCore },
 * });
 * ```
 */
export function createMemoryClient(config: TransportConfig): MemoryClient {
  switch (config.type) {
    case "http":
      return new HttpMemoryClient(config.options);
    case "in-process":
      return new InProcessMemoryClient(config.options);
    default: {
      // 穷尽性检查
      const _exhaustive: never = config;
      throw new Error(`Unknown transport type: ${(config as TransportConfig).type}`);
    }
  }
}

/**
 * 从环境变量解析配置并创建 MemoryClient。
 *
 * 环境变量：
 *   TDAI_ADAPTER_TRANSPORT  — "http" | "in-process"（默认 "http"）
 *   TDAI_GATEWAY_URL         — Gateway base URL（默认 "http://127.0.0.1:8420"）
 *   TDAI_GATEWAY_API_KEY     — Bearer token
 *   TDAI_ADAPTER_TIMEOUT_MS  — 请求超时毫秒数（默认 30000）
 *
 * @example
 * ```ts
 * // 默认 HTTP transport
 * const client = createMemoryClientFromEnv();
 *
 * // 带 process.env stub（测试用）
 * const client = createMemoryClientFromEnv({ TDAI_GATEWAY_URL: "http://gw:8420" });
 * ```
 */
export function createMemoryClientFromEnv(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env as Record<string, string | undefined> : {},
): MemoryClient {
  const transportType = env.TDAI_ADAPTER_TRANSPORT ?? "http";

  if (transportType === "in-process") {
    return new InProcessMemoryClient({
      configPath: env.TDAI_GATEWAY_CONFIG_PATH,
      dataDir: env.TDAI_DATA_DIR,
    });
  }

  // 默认：HTTP transport
  return new HttpMemoryClient({
    baseUrl: env.TDAI_GATEWAY_URL ?? "http://127.0.0.1:8420",
    apiKey: env.TDAI_GATEWAY_API_KEY,
    timeoutMs: env.TDAI_ADAPTER_TIMEOUT_MS ? parseInt(env.TDAI_ADAPTER_TIMEOUT_MS, 10) : undefined,
  });
}
