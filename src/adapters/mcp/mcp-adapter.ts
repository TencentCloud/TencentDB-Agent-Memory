/**
 * MCP 适配器 — MemoryPlatformAdapter 的 MCP 实现。
 *
 * 包装 McpServer 为 MemoryPlatformAdapter 接口，方便
 * 合约测试和统一管理。
 */

import { BaseMemoryPlatformAdapter } from "../memory-platform-adapter.js";
import type { GatewayClient } from "../shared/gateway-client.js";

/**
 * MCP 平台适配器。
 *
 * 直接委托给 GatewayClient，与 McpServer 共享同一客户端。
 */
export class McpMemoryAdapter extends BaseMemoryPlatformAdapter {
  readonly name = "mcp-adapter";
  readonly platform = "mcp";

  constructor(client: GatewayClient) {
    super(client);
  }
}
