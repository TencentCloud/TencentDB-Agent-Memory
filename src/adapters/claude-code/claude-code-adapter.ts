/**
 * Claude Code 原生适配器 — MemoryPlatformAdapter 的 Claude Code 实现。
 *
 * Claude Code 支持两种集成模式：
 * 1. MCP 模式：.mcp.json 配置 MCP 服务器
 * 2. 原生 Hook 模式：.claude/settings.json hooks 配置
 *
 * 此适配器提供 Hook 配置生成器和 CLI 入口。
 */

import { BaseMemoryPlatformAdapter } from "../memory-platform-adapter.js";
import type { GatewayClient } from "../shared/gateway-client.js";

/**
 * Claude Code 平台适配器。
 */
export class ClaudeCodeMemoryAdapter extends BaseMemoryPlatformAdapter {
  readonly name = "claude-code-adapter";
  readonly platform = "claude-code";

  constructor(client: GatewayClient) {
    super(client);
  }
}
