#!/usr/bin/env node
/**
 * Claude Code MCP server entry point.
 * All configuration via TDAI_* env vars — see bin/shared.ts for the complete list.
 *
 * Example .claude/settings.json:
 *   {
 *     "mcpServers": {
 *       "tdai-memory": {
 *         "command": "npx",
 *         "args": ["tdai-claude-code-mcp"],
 *         "env": {
 *           "TDAI_LLM_BASE_URL": "https://api.openai.com/v1",
 *           "TDAI_LLM_API_KEY": "sk-...",
 *           "TDAI_LLM_MODEL": "gpt-4o"
 *         }
 *       }
 *     }
 *   }
 */

import { ClaudeCodeMcpServer } from "../src/adapters/claude-code/index.js";
import { loadEnvOptions } from "./shared.js";

new ClaudeCodeMcpServer(loadEnvOptions("claude-code")).start().catch((err: unknown) => {
  process.stderr.write(
    `[tdai-claude-code-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
