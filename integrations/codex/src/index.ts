import { loadCodexAdapterConfig } from "./config.js";
import { pathToFileURL } from "node:url";
import { stderrLogger } from "./logger.js";
import { CodexMcpServer } from "./mcp-server.js";

export { loadCodexAdapterConfig } from "./config.js";
export { GatewayClient, GatewayClientError } from "./gateway-client.js";
export { GatewaySupervisor } from "./gateway-supervisor.js";
export { ResultFormatter } from "./result-formatter.js";
export { SessionResolver, sanitizeSessionKey } from "./session-resolver.js";
export { TOOL_DEFINITIONS } from "./tools.js";
export { CodexMcpServer } from "./mcp-server.js";
export type * from "./types.js";

export async function main(): Promise<void> {
  const server = new CodexMcpServer({
    config: loadCodexAdapterConfig(process.env, stderrLogger),
    logger: stderrLogger,
  });
  const shutdown = async () => {
    await server.shutdown().catch((error) => stderrLogger.warn(`Shutdown failed: ${String(error)}`));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await server.start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
