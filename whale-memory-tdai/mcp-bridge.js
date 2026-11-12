#!/usr/bin/env node
/**
 * Tdai MCP bridge — a minimal Model Context Protocol server over stdio
 * (newline-delimited JSON-RPC 2.0, no external dependencies).
 *
 * Thin shim over the shared SDK: proxies `search_memories` and
 * `search_conversations` tool calls to the TdaiGateway, exposing TencentDB
 * Agent Memory to any MCP-aware host (Codex, Whale, etc.).
 *
 * Env:
 *   TDAI_GATEWAY_URL       Gateway base URL (default http://127.0.0.1:8420)
 *   TDAI_GATEWAY_API_KEY   Optional Bearer token
 */

import { TdaiGatewayClient, createMcpBridge } from "./vendor/tdai-sdk/index.js";

createMcpBridge({ client: new TdaiGatewayClient() }).start();
