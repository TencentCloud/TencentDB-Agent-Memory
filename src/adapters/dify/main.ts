/**
 * Dify adapter — CLI entry point.
 *
 * Usage:
 *   node --import tsx src/adapters/dify/main.ts
 *
 * Environment:
 *   TDAI_ADAPTER_TRANSPORT    "http" (default — needs a running Gateway) | "in-process"
 *   TDAI_GATEWAY_URL          Gateway base URL (default http://127.0.0.1:8420)
 *   TDAI_GATEWAY_API_KEY      Bearer token when the Gateway enforces auth
 *   TDAI_ADAPTER_TIMEOUT_MS   HTTP timeout toward the Gateway (default 10000)
 *   TDAI_DIFY_PORT            listen port (default 8421)
 *   TDAI_DIFY_HOST            bind host (default 127.0.0.1)
 *   TDAI_DIFY_API_KEY         Bearer key Dify must present (recommended!)
 *   TDAI_DIFY_SESSION_KEY     default session key for /tools/* (default "dify:default")
 */

import { createMemoryClient, resolveClientOptionsFromEnv } from "../../adapter-sdk/index.js";
import type { Logger } from "../../core/types.js";
import { getEnv } from "../../utils/env.js";
import { isMainModule } from "../../utils/is-main.js";
import { DifyMemoryAdapter } from "./server.js";

const TAG = "[tdai-adapter] [dify-main]";

/**
 * Plain console logger — no prefix of its own, because every message from
 * the SDK / adapter already carries a `[tdai-adapter] [...]` tag.
 */
function createConsoleLogger(): Logger {
  return {
    debug: (msg: string) => console.debug(msg),
    info: (msg: string) => console.info(msg),
    warn: (msg: string) => console.warn(msg),
    error: (msg: string) => console.error(msg),
  };
}

function envInt(key: string): number | undefined {
  const raw = getEnv(key)?.trim();
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

async function main(): Promise<void> {
  const logger = createConsoleLogger();

  const clientOptions = resolveClientOptionsFromEnv(logger);
  clientOptions.logger = logger;
  const client = createMemoryClient(clientOptions);

  const adapter = new DifyMemoryAdapter({
    client,
    port: envInt("TDAI_DIFY_PORT"),
    host: getEnv("TDAI_DIFY_HOST")?.trim() || undefined,
    apiKey: getEnv("TDAI_DIFY_API_KEY"),
    defaultSessionKey: getEnv("TDAI_DIFY_SESSION_KEY")?.trim() || undefined,
    logger,
  });

  // Graceful shutdown — mirror the Gateway's main() shape.
  const shutdown = async () => {
    logger.info(`${TAG} Shutting down Dify adapter...`);
    await adapter.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await adapter.start();
  logger.info(`${TAG} Memory transport: ${clientOptions.transport}`);
}

// Auto-start when run directly. Unlike gateway/server.ts (whose "server.ts"
// suffix contains no separator), these suffixes contain a "/" — isMainModule
// normalizes Windows backslash argv[1] paths so the match works there too.
const isMain = isMainModule(process.argv[1], ["dify/main.ts", "dify/main.js"]);
if (isMain) {
  main().catch((err) => {
    console.error(`${TAG} Dify adapter startup failed:`, err);
    process.exit(1);
  });
}
