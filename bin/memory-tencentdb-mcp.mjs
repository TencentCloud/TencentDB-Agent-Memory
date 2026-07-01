#!/usr/bin/env node
/**
 * memory-tencentdb-mcp — MCP stdio 服务器入口。
 *
 * 启动 MCP 服务器，从环境变量读取配置：
 * - TDAI_GATEWAY_URL: Gateway 地址（默认 http://127.0.0.1:8420）
 * - TDAI_GATEWAY_API_KEY: API Key（可选）
 */

import { McpServer } from "../src/adapters/mcp/mcp-server.js";

const gatewayUrl = process.env.TDAI_GATEWAY_URL ?? "http://127.0.0.1:8420";
const apiKey = process.env.TDAI_GATEWAY_API_KEY;

const server = new McpServer({
  gatewayUrl,
  apiKey,
  name: "memory-tencentdb",
  version: "0.1.0",
});

server.start().catch((err) => {
  console.error("[mcp-server] 致命错误:", err);
  process.exit(1);
});
