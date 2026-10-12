/**
 * MCP 调用身份解析。
 *
 * 优先级：
 *   1. 客户端 MCP 连接配置的 request header（X-Team-Id / X-Agent-Id / X-User-Id）
 *   2. 服务端 config.yaml 静态配置（mcp.teamId / mcp.agentId / mcp.userId）
 *
 * 工具调用参数中出现的身份字段 MUST 被此处解析结果覆盖，LLM 不可伪造身份。
 */

import type { McpConfig } from "../types.js";

/** 解析后的请求身份，注入所有转发 MemoryCore 的请求体。 */
export interface McpIdentity {
  team_id: string;
  agent_id?: string;
  user_id?: string;
}

/**
 * 从 HTTP request headers 与服务端静态配置中解析调用身份。
 *
 * @throws Error - 当 team_id 在 header 与服务端配置中均不存在时。
 */
export function resolveIdentity(
  headers: {
    get(name: string): string | null | undefined;
  },
  mcpConfig: McpConfig,
): McpIdentity {
  // header 优先，fallback 到服务端静态配置
  const teamId =
    (headers.get("x-team-id") ?? "").trim() || mcpConfig.teamId.trim();
  const agentId =
    (headers.get("x-agent-id") ?? "").trim() || mcpConfig.agentId.trim() || undefined;
  const userId =
    (headers.get("x-user-id") ?? "").trim() || mcpConfig.userId.trim() || undefined;

  if (!teamId) {
    throw new Error(
      "缺少 team 身份：请通过 X-Team-Id header 或服务端 mcp.teamId 配置提供 team_id",
    );
  }

  return { team_id: teamId, agent_id: agentId, user_id: userId };
}

/**
 * 从 HTTP request headers 获取 serviceId（供 verifyUserKey 使用）。
 *
 * 取 X-Space-Id header；无则 fallback 到 mcp.spaceId 静态配置。
 */
export function resolveServiceId(
  headers: {
    get(name: string): string | null | undefined;
  },
  mcpConfig: McpConfig,
): string {
  return (headers.get("x-space-id") ?? "").trim() || mcpConfig.spaceId.trim();
}
