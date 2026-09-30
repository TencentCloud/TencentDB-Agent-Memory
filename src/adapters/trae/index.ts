/**
 * Trae adapter — barrel export for Trae-specific integration layer.
 *
 * Exports hook handlers, MCP server, and types for Trae platform integration.
 * Provides both programmatic API and stdio MCP server entry point.
 */

export { handleTraeHook } from "./hook-handler.js";
export type { TraeHookEvent, TraeHookInput, TraeHookOutput } from "./hook-handler.js";
export { TraeMcpServer, runStdioTraeMcp } from "./mcp-server.js";
