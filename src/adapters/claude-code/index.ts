/**
 * Claude Code adapter — barrel export.
 *
 * Usage in a Claude Code hook script:
 * ```ts
 * import { ClaudeCodeAdapter } from "memory-tdai/src/adapters/claude-code/index.js";
 * import { MemoryPlugin } from "memory-tdai/src/sdk/plugin.js";
 * ```
 *
 * Or via CLI (from settings.json hooks):
 * ```json
 * {
 *   "hooks": {
 *     "preMessage": [{ "matcher": "*", "run": "memory-tdai claude-code-recall" }],
 *     "postMessage": [{ "matcher": "*", "run": "memory-tdai claude-code-capture" }]
 *   },
 *   "mcpServers": {
 *     "memory-tdai": {
 *       "command": "npx",
 *       "args": ["--package", "@tencentdb-agent-memory/memory-tencentdb", "memory-tencentdb-mcp"]
 *     }
 *   }
 * }
 * ```
 */

export { ClaudeCodeAdapter } from "./adapter.js";

// Re-export the entry-point functions for direct programmatic use.
// Hook scripts can call these instead of manually wiring adapter → plugin.
export { claudeCodeRecall } from "./cli-recall.js";
export { claudeCodeCapture } from "./cli-capture.js";

// MCP server is available at "memory-tdai/adapters/mcp"
// (via `createMcpServer` from ../mcp/server.js)
