/**
 * MCP Hono 处理器工厂。
 *
 * `createMcpHandler(config)` 返回一个 Hono `app.all("/mcp", handler)` 回调，
 * 实现 MCP 2026-07-28 Streamable HTTP 无状态端点：
 *
 *   - GET / DELETE → 405 Method Not Allowed
 *   - POST：
 *     1. 鉴权：提取 Authorization: Bearer <key>，fallback 到 config.mcp.apiKey；
 *        调用 verifyUserKey；失败 → 401
 *     2. 限流：调用 enforceRateLimit（QPM 门控，modelId 固定为 "mcp"，
 *        instanceId = serviceId；QPM=0 时自动跳过）；超限 → 429
 *     3. 身份解析：resolveIdentity() 从 header / config 提取 team_id 等
 *     4. 每请求创建新 McpServer + WebStandardStreamableHTTPServerTransport（无状态）
 *     5. 将请求委托给 transport.handleRequest()
 *
 * 无状态模式：服务端不持有 session 状态，不返回 Mcp-Session-Id；
 * Last-Event-ID / Mcp-Session-Id 请求头直接忽略（SDK 不处理，自然无效）。
 */

import type { Context } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { verifyUserKey } from "../auth.js";
import { getCoreSkillClient } from "../skill/core-client.js";
import { enforceRateLimit, RateLimitExceededError } from "../rate-limit/guard.js";
import { resolveIdentity, resolveServiceId } from "./identity.js";
import { createMcpServer } from "./server.js";
import { log } from "../report/log.js";
import type { ProxyConfig } from "../types.js";

/** MCP 限流占位 modelId（不执行推理，仅用于 QPM 计数桶的 key 部分）。 */
const MCP_MODEL_ID = "mcp";

/**
 * 从 HTTP Authorization header 提取 Bearer token。
 * 返回空字符串表示未提供或格式错误。
 */
function extractBearer(authHeader: string): string {
  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return "";
  return authHeader.slice(prefix.length).trim();
}

/**
 * 创建绑定到 config 的 Hono MCP 请求处理器。
 *
 * 用法（server.ts）：
 *   if (config.mcp?.enabled) {
 *     const mcpHandler = createMcpHandler(config);
 *     app.all("/mcp", (c) => mcpHandler(c));
 *   }
 */
export function createMcpHandler(
  config: ProxyConfig,
): (c: Context) => Promise<Response> {
  // config.mcp 由调用者保证非空（启用检查在 server.ts 里）
  const mcpConfig = config.mcp!;

  return async (c: Context): Promise<Response> => {
    const method = c.req.method.toUpperCase();

    // ── GET / DELETE → 405 ────────────────────────────────────────────────────
    if (method !== "POST") {
      return new Response(
        JSON.stringify({ error: "method_not_allowed", message: "MCP endpoint only accepts POST" }),
        {
          status: 405,
          headers: {
            "content-type": "application/json",
            allow: "POST",
          },
        },
      );
    }

    // ── 鉴权 ──────────────────────────────────────────────────────────────────
    const authHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
    const bearerToken = extractBearer(authHeader);
    const apiKey = bearerToken || mcpConfig.apiKey;

    let serviceId: string;
    try {
      serviceId = resolveServiceId(c.req.raw.headers, mcpConfig);
    } catch {
      serviceId = "";
    }

    const authResult = await verifyUserKey(apiKey, serviceId);
    if (authResult.rejected) {
      log.warn("mcp.auth.rejected", { reason: authResult.rejectReason, serviceId });
      return new Response(
        JSON.stringify({
          error: "unauthorized",
          message: authResult.rejectReason ?? "invalid api key",
        }),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
      );
    }

    // ── 限流（QPM，鉴权通过后） ────────────────────────────────────────────────
    // serviceId 为空时 enforceRateLimit 内部已短路（不限流），无需额外判断。
    try {
      await enforceRateLimit({
        config,
        instanceId: serviceId || undefined,
        modelId: MCP_MODEL_ID,
        protocol: "openai", // 仅用于构建 429 响应格式，与协议无关
      });
    } catch (err) {
      if (err instanceof RateLimitExceededError) {
        return err.response;
      }
      // 限流检查本身出错时 fail-open（guard.ts 内部已记日志）
    }

    // ── 身份解析 ──────────────────────────────────────────────────────────────
    let identity;
    try {
      identity = resolveIdentity(c.req.raw.headers, mcpConfig);
    } catch (err) {
      return new Response(
        JSON.stringify({
          error: "bad_request",
          message: (err as Error).message,
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );
    }

    // ── 每请求创建新 MCP 实例（无状态） ──────────────────────────────────────
    const skillClient = getCoreSkillClient(config.coreSkill);
    const mcpServer = createMcpServer(skillClient, identity);
    const transport = new WebStandardStreamableHTTPServerTransport();

    try {
      await mcpServer.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } catch (err) {
      log.warn("mcp.request.error", { error: (err as Error).message });
      return new Response(
        JSON.stringify({ error: "internal_error", message: "MCP request failed" }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      );
    }
  };
}
