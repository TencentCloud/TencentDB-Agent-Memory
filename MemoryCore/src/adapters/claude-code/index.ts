/**
 * Claude Code MCP adapter — barrel exports.
 *
 * This is the single import point for integrating the TDAI memory system
 * with Anthropic's Claude Code CLI via the Model Context Protocol.
 *
 *   ```typescript
 *   import {
 *     ClaudeCodeAdapter,
 *     TdaiMcpServer,
 *     main,
 *   } from "./claude-code/index.js";
 *   ```
 *
 * To run as a standalone MCP server:
 *   ```bash
 *   node dist/adapters/claude-code/adapter.js
 *   ```
 *
 * The server reads configuration from environment variables (see
 * {@link ClaudeCodeAdapter.resolveConfig} for the full list).
 */

// Adapter class and configuration
export { ClaudeCodeAdapter } from "./adapter.js";
export type { ClaudeCodeAdapterConfig } from "./adapter.js";

// Claude Code message format types (for consumers that need to type
// conversation data before passing it to normalizeMessages)
export type { ClaudeMessage, ClaudeContentBlock } from "./adapter.js";

// MCP server
export { TdaiMcpServer } from "./mcp-server.js";

// Entry point
export { main } from "./adapter.js";
