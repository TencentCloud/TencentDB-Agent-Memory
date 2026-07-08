#!/usr/bin/env node
/**
 * memory-tencentdb-mcp — MCP server CLI entry.
 *
 * Spawns the MCP server which speaks stdio JSON-RPC with any MCP-compatible
 * client (Claude Code, Codex, Cursor, Cline, etc.). All logs go to stderr;
 * stdout is reserved for the JSON-RPC protocol bytes.
 */

import "../dist/src/adapters/mcp/server.mjs";
