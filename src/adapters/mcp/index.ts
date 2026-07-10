/**
 * TDAI Memory MCP adapter — barrel export.
 *
 * Provides a stdio-based MCP server that exposes the TDAI Gateway's
 * memory capabilities (recall, capture, search, session management)
 * through the Model Context Protocol.
 *
 * Usage (CLI):
 * ```bash
 * memory-tencentdb-mcp
 * ```
 *
 * Usage (programmatic):
 * ```ts
 * import { createMcpServer, TdaiMcpServer } from "./index.js";
 * const server = createMcpServer();
 * await server.start();
 * ```
 */

export { TdaiMcpServer, createMcpServer } from "./server.js";
export type { McpServerOptions } from "./server.js";
