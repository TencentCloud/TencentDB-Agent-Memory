#!/usr/bin/env node

import {
  createMcpServerFromEnvironment,
  runStdioMcpServer,
} from "./server.js";

try {
  await runStdioMcpServer(createMcpServerFromEnvironment());
} catch (error) {
  // STDOUT is reserved for MCP JSON-RPC frames.
  process.stderr.write(
    `[memory-tencentdb-mcp] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
