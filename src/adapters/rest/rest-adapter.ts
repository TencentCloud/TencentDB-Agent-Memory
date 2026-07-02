/**
 * REST 通用适配器 — 最简 MemoryPlatformAdapter 实现。
 *
 * 纯 HTTP 客户端，零平台特定逻辑。适用于任何可以
 * 发送 HTTP 请求的 Agent 平台。
 *
 * 这是所有适配器中最简单的一个，也作为
 * 其他适配器的参考实现。
 */

import { BaseMemoryPlatformAdapter } from "../memory-platform-adapter.js";
import type { GatewayClient } from "../shared/gateway-client.js";

/**
 * REST 通用适配器。
 *
 * 直接委托给 GatewayClient，不添加任何协议转换。
 *
 * @example
 * ```ts
 * const adapter = new RestMemoryAdapter(new GatewayClient({
 *   baseUrl: "http://127.0.0.1:8420",
 * }));
 * await adapter.recall("最近聊了什么", "session-1");
 * ```
 */
export class RestMemoryAdapter extends BaseMemoryPlatformAdapter {
  readonly name = "rest-adapter";
  readonly platform = "rest";

  constructor(client: GatewayClient) {
    super(client);
  }

  /** 暴露底层 GatewayClient（用于测试和调试）。 */
  get gatewayClient(): GatewayClient {
    return this.client;
  }
}
