/**
 * Claude Code adapter — barrel.
 *
 * MCP stdio server exposing TDAI memory tools to Claude Code (or any MCP
 * client). Built entirely on the Adapter SDK — see ./README.md for setup.
 */

export { TdaiMcpServer, SUPPORTED_PROTOCOL_VERSIONS, SERVER_NAME } from "./mcp-server.js";
export type { TdaiMcpServerOptions } from "./mcp-server.js";
export { TOOL_DEFINITIONS, dispatchToolCall, clampLimit, UnknownToolError } from "./tools.js";
export type { McpToolDefinition, ToolDispatchContext } from "./tools.js";
export * from "./jsonrpc.js";
