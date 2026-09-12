#!/usr/bin/env node
/**
 * Codex CLI MCP server entry point.
 * All configuration via TDAI_* env vars — see bin/shared.ts for the complete list.
 *
 * Example ~/.codex/config.toml:
 *   [mcp_servers.tdai-memory]
 *   command = "tdai-codex-mcp"
 *   env = { TDAI_LLM_BASE_URL = "...", TDAI_LLM_API_KEY = "...", TDAI_LLM_MODEL = "..." }
 */

import { CodexMcpServer } from "../src/adapters/codex/index.js";
import { loadEnvOptions } from "./shared.js";

new CodexMcpServer(loadEnvOptions("codex")).start().catch((err: unknown) => {
  process.stderr.write(
    `[tdai-codex-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
