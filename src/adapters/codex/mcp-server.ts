/**
 * CodexMcpServer — MCP server adapter for OpenAI Codex CLI.
 *
 * Codex CLI supports MCP servers via ~/.codex/config.toml.
 * Capture is explicit: the LLM calls tdai_memory_capture as instructed
 * by the Codex instructions config (~/.codex/instructions.md).
 *
 * Usage (in ~/.codex/config.toml):
 *   [mcp_servers]
 *   [mcp_servers.tdai-memory]
 *   command = "tdai-codex-mcp"
 *   env = { TDAI_DATA_DIR = "~/.tdai/codex", TDAI_LLM_BASE_URL = "...", ... }
 */

import { McpServerBase } from "../mcp-server-base.js";
import { CodexHostAdapter } from "./host-adapter.js";
import type { McpHostAdapter } from "../mcp-server-base.js";

export class CodexMcpServer extends McpServerBase {
  protected createAdapter(): McpHostAdapter {
    return new CodexHostAdapter({ ...this.opts, logger: this.logger });
  }
}
