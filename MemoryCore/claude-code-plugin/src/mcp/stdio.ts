#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config.js";
import { createKnowledge, createMemoryClient } from "../client.js";
import { createClaudeCodeMcpServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createClaudeCodeMcpServer({
    memory: createMemoryClient(config, config.captureTimeoutMs),
    knowledge: createKnowledge(config),
  });
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`[tdai][claude-code][mcp] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
