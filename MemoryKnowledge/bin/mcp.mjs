#!/usr/bin/env node
import { startMcpServer } from "../dist/mcp/server.mjs";

startMcpServer().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
