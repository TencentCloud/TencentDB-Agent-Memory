#!/usr/bin/env node
/**
 * memory-tencentdb-mcp — CLI entry point for the MCP stdio server.
 *
 * Exposes the TDAI Gateway as a Model Context Protocol server over
 * stdio transport. Compatible with Codex, Claude Code, Cursor,
 * CodeBuddy, Trae IDE, and any other MCP-compliant client.
 *
 * ─── Usage ─────────────────────────────────────────────────────────────────
 *
 * ```bash
 * # Direct
 * memory-tencentdb-mcp
 *
 * # With environment (or set TDAI_GATEWAY_URL / TDAI_GATEWAY_API_KEY)
 * TDAI_GATEWAY_URL=http://127.0.0.1:8420 memory-tencentdb-mcp
 * ```
 *
 * ─── Codex config.toml ─────────────────────────────────────────────────────
 *
 * ```toml
 * [mcp_servers.tencentdb_memory]
 * command = "memory-tencentdb-mcp"
 * env = { TDAI_GATEWAY_URL = "http://127.0.0.1:8420", TDAI_GATEWAY_API_KEY = "your-key" }
 * ```
 *
 * ─── Claude Code settings.json ─────────────────────────────────────────────
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "memory-tdai": {
 *       "command": "npx",
 *       "args": ["--package", "@tencentdb-agent-memory/memory-tencentdb", "memory-tencentdb-mcp"]
 *     }
 *   }
 * }
 * ```
 *
 * @see TdaiMcpServer — the MCP server implementation
 */

import { createMcpServer } from "./server.js";

try {
  const server = createMcpServer();
  await server.start();
} catch (error) {
  // STDOUT is reserved for MCP JSON-RPC frames.
  process.stderr.write(
    `[memory-tencentdb-mcp] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
