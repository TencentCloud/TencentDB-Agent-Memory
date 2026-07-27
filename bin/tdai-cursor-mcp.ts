#!/usr/bin/env node
/**
 * Cursor MCP server entry point.
 * All configuration via TDAI_* env vars — see bin/shared.ts for the complete list.
 *
 * Example ~/.cursor/mcp.json:
 *   {
 *     "mcpServers": {
 *       "tdai-memory": {
 *         "command": "tdai-cursor-mcp",
 *         "env": { "TDAI_LLM_BASE_URL": "...", "TDAI_LLM_API_KEY": "...", "TDAI_LLM_MODEL": "..." }
 *       }
 *     }
 *   }
 */

import { CursorMcpServer } from "../src/adapters/cursor/index.js";
import { loadEnvOptions } from "./shared.js";

new CursorMcpServer(loadEnvOptions("cursor")).start().catch((err: unknown) => {
  process.stderr.write(
    `[tdai-cursor-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
