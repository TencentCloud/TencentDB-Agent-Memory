/**
 * Claude Code adapter — CLI entry point.
 *
 * Usage:
 *   node --import tsx src/adapters/claude-code/main.ts
 *
 * Environment:
 *   TDAI_ADAPTER_TRANSPORT   "http" (default — needs a running Gateway) | "in-process"
 *   TDAI_GATEWAY_URL         Gateway base URL (default http://127.0.0.1:8420)
 *   TDAI_GATEWAY_API_KEY     Bearer token when the Gateway enforces auth
 *   TDAI_ADAPTER_TIMEOUT_MS  HTTP timeout (default 10000)
 *   TDAI_SESSION_KEY         default session key (default "claude-code:<cwd basename>")
 *   TDAI_USER_ID             reserved user id — sent with requests, currently
 *                            ignored by the engine (default "default_user")
 *
 * stdio contract: stdout carries ONLY MCP protocol lines; every log line goes
 * to stderr. Breaking this corrupts the client's JSON stream — the classic
 * stdio-MCP failure mode.
 */

import path from "node:path";
import { createRequire } from "node:module";
import { createMemoryClient, resolveClientOptionsFromEnv } from "../../adapter-sdk/index.js";
import type { Logger } from "../../core/types.js";
import { getEnv } from "../../utils/env.js";
import { isMainModule } from "../../utils/is-main.js";
import { TdaiMcpServer } from "./mcp-server.js";

const TAG = "[tdai-adapter] [mcp-main]";

/**
 * All log levels go to stderr — stdout is reserved for the protocol.
 * No prefix of its own: messages from the SDK / server already carry a
 * `[tdai-adapter] [...]` tag.
 */
function createStderrLogger(): Logger {
  const write = (level: string, msg: string) => {
    process.stderr.write(`[${level}] ${msg}\n`);
  };
  return {
    debug: (msg: string) => write("debug", msg),
    info: (msg: string) => write("info", msg),
    warn: (msg: string) => write("warn", msg),
    error: (msg: string) => write("error", msg),
  };
}

function readPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  const logger = createStderrLogger();

  const clientOptions = resolveClientOptionsFromEnv(logger);
  clientOptions.logger = logger;
  const client = createMemoryClient(clientOptions);

  const sessionKey =
    getEnv("TDAI_SESSION_KEY")?.trim() || `claude-code:${path.basename(process.cwd())}`;
  const userId = getEnv("TDAI_USER_ID")?.trim() || "default_user";

  const server = new TdaiMcpServer({
    client,
    sessionKey,
    userId,
    logger,
    serverVersion: readPackageVersion(),
  });

  // Graceful shutdown — mirror the Gateway's main() shape.
  let stopping = false;
  const shutdown = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    logger.info(`${TAG} Shutting down (${reason})...`);
    try {
      await server.stop();
    } catch (err) {
      logger.warn(`${TAG} Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info(
    `${TAG} Starting MCP stdio server: transport=${clientOptions.transport}, session_key=${sessionKey}`,
  );

  // Resolves when stdin closes (client disconnected) — then exit cleanly.
  await server.start();
  await shutdown("stdin closed");
}

// Auto-start when run directly. Unlike gateway/server.ts (whose "server.ts"
// suffix contains no separator), these suffixes contain a "/" — isMainModule
// normalizes Windows backslash argv[1] paths so the match works there too.
const isMain = isMainModule(process.argv[1], ["claude-code/main.ts", "claude-code/main.js"]);
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`${TAG} [fatal] MCP server startup failed: ${String(err)}\n`);
    process.exit(1);
  });
}
