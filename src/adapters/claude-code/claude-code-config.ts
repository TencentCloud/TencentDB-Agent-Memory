/**
 * Claude Code 配置生成器。
 *
 * 生成文件：
 * - .mcp.json: MCP 服务器配置
 * - .claude/settings.json: Hook 配置
 *
 * CLI 入口：`npx memory-tencentdb claude-code init`
 */

/**
 * Claude Code MCP 配置结构（.mcp.json）。
 */
export interface ClaudeCodeMcpConfig {
  mcpServers: Record<string, ClaudeCodeMcpServer>;
}

export interface ClaudeCodeMcpServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * 生成 Claude Code .mcp.json 配置。
 */
export function generateClaudeCodeMcpConfig(
  nodePath = "npx",
  gatewayUrl = "http://127.0.0.1:8420",
  apiKey?: string,
): ClaudeCodeMcpConfig {
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
