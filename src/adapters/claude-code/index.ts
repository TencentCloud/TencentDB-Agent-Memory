/**
 * Claude Code adapter — barrel exports.
 *
 * Re-exports all public API surfaces for the Claude Code MCP server adapter.
 * Consumers typically only need ClaudeCodeMcpServer to start the server.
 *
 * Example:
 *   import { ClaudeCodeMcpServer } from "tencentdb-agent-memory/adapters/claude-code";
 *   const server = new ClaudeCodeMcpServer({ dataDir, llmConfig });
 *   await server.start();
 */

export { ClaudeCodeHostAdapter } from "./host-adapter.js";
export { ClaudeCodeMcpServer } from "./mcp-server.js";
export type { ClaudeCodeHostAdapterOptions, ClaudeCodeMcpServerOptions } from "./types.js";
