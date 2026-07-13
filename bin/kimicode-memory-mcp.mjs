#!/usr/bin/env node
/**
 * Entry point used by the Kimi Code CLI MCP configuration.
 *
 * The Kimi MCP server forwards tool calls to the TDAI Gateway over HTTP.
 * Make sure the gateway is running (default URL: http://127.0.0.1:8420).
 */

import { runKimiCodeMcpServer } from "../dist/src/adapters/kimicode/mcp-server.mjs";

runKimiCodeMcpServer().catch((err) => {
  console.error(err);
  process.exit(1);
});
