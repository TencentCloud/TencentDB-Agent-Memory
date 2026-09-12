/**
 * CursorMcpServer — MCP server adapter for Cursor.
 *
 * Cursor does not provide a Stop-hook equivalent, so capture must be done
 * explicitly via `tdai_memory_capture` (or the user includes that instruction
 * in their Cursor Rule). This class inherits all MCP JSON-RPC machinery
 * from McpServerBase without any additional platform logic.
 *
 * Usage (in ~/.cursor/mcp.json or .cursor/mcp.json):
 *   {
 *     "mcpServers": {
 *       "tdai-memory": {
 *         "command": "tdai-cursor-mcp",
 *         "env": { "TDAI_DATA_DIR": "~/.tdai/cursor", ... }
 *       }
 *     }
 *   }
 */

import { McpServerBase } from "../mcp-server-base.js";
import { CursorHostAdapter } from "./host-adapter.js";
import type { McpHostAdapter } from "../mcp-server-base.js";

export class CursorMcpServer extends McpServerBase {
  protected createAdapter(): McpHostAdapter {
    return new CursorHostAdapter({ ...this.opts, logger: this.logger });
  }
}
