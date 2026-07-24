#!/usr/bin/env node

import { runMemoryMcpServer } from "./server.js";

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8420";
const DEFAULT_TIMEOUT_MS = 10_000;

function optionalEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function parseTimeout(value: string | undefined): number {
  if (!value) return DEFAULT_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error("TDAI_MCP_TIMEOUT_MS must be a positive integer");
  }
  return timeout;
}

async function main(): Promise<void> {
  const server = await runMemoryMcpServer({
    gateway: {
      baseUrl: optionalEnv("TDAI_MCP_GATEWAY_URL") ?? DEFAULT_GATEWAY_URL,
      apiKey: optionalEnv("TDAI_GATEWAY_API_KEY"),
      timeoutMs: parseTimeout(optionalEnv("TDAI_MCP_TIMEOUT_MS")),
    },
    sessionKey: optionalEnv("TDAI_MCP_SESSION_KEY"),
    userId: optionalEnv("TDAI_MCP_USER_ID"),
  });

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  // stdout is reserved exclusively for MCP JSON-RPC messages.
  console.error(
    `[tdai-mcp] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
