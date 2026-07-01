/**
 * Codex 原生适配器 — MemoryPlatformAdapter 的 Codex 实现。
 *
 * Codex 支持两种集成模式：
 * 1. MCP 模式：使用 MCP 服务器（覆盖所有 MCP 客户端）
 * 2. 原生 Hook 模式：Hook 配置 + CLI 入口（此适配器）
 *
 * 此适配器提供 CLI 命令供 Codex hooks 调用。
 * 推荐同时启用 MCP 模式和 Hook 模式以获得最佳体验。
 */

import { BaseMemoryPlatformAdapter } from "../memory-platform-adapter.js";
import type { GatewayClient } from "../shared/gateway-client.js";

/**
 * Codex 平台适配器。
 */
export class CodexMemoryAdapter extends BaseMemoryPlatformAdapter {
  readonly name = "codex-adapter";
  readonly platform = "codex";

  constructor(client: GatewayClient) {
    super(client);
  }

  /**
   * 从环境变量中读取 Codex hook 上下文。
   *
   * Codex 通过环境变量向 hook 脚本传递上下文信息。
   */
  getHookContext(): CodexHookContext {
    return {
      sessionKey: process.env.CODEX_SESSION_KEY ?? process.env.CODEX_CONVERSATION_ID ?? "codex-default",
      prompt: process.env.CODEX_PROMPT ?? "",
      lastAssistantMessage: process.env.CODEX_LAST_ASSISTANT_MESSAGE ?? "",
    };
  }
}

/**
 * Codex hook 上下文。
 */
export interface CodexHookContext {
  sessionKey: string;
  prompt: string;
  lastAssistantMessage: string;
}
