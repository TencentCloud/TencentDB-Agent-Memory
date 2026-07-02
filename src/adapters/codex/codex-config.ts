/**
 * Codex 配置生成器 — 生成 .codex/ 目录下的配置文件。
 *
 * 生成文件：
 * - .codex/config.json: MCP 工具配置
 * - .codex/hooks/hooks.json: Codex hook 配置（可选）
 *
 * CLI 入口：`npx memory-tencentdb codex init`
 */

import type { McpToolDefinition } from "../mcp/mcp-types.js";
import { TDAI_TOOLS } from "../mcp/mcp-types.js";

/**
 * Codex MCP 配置文件结构（.codex/config.json 中的 mcpServers 字段）。
 */
export interface CodexMcpConfig {
  mcpServers: Record<string, CodexMcpServer>;
}

export interface CodexMcpServer {
  /** MCP 服务器启动命令。 */
  command: string;
  /** 命令行参数。 */
  args: string[];
  /** 环境变量。 */
  env?: Record<string, string>;
}

/**
 * 生成 Codex MCP 配置。
 *
 * 在 .codex/config.json 中添加 MCP 服务器配置。
 */
export function generateCodexMcpConfig(
  nodePath = "npx",
  gatewayUrl = "http://127.0.0.1:8420",
  apiKey?: string,
): CodexMcpConfig {
  const env: Record<string, string> = {
    TDAI_GATEWAY_URL: gatewayUrl,
  };
  if (apiKey) env.TDAI_GATEWAY_API_KEY = apiKey;

  return {
    mcpServers: {
      "memory-tencentdb": {
        command: nodePath,
        args: ["@tencentdb-agent-memory/memory-tencentdb", "mcp"],
        env,
      },
    },
  };
}

/**
 * 生成 Codex 可用的工具列表（用于文档和校验）。
 */
export function getCodexTools(): McpToolDefinition[] {
  return TDAI_TOOLS;
}
