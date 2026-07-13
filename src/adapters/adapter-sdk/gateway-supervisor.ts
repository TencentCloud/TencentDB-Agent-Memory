import { GatewayClient } from "./gateway-client.js";
import type { Logger } from "./types.js";

export interface EnsureGatewayOptions {
  gateway?: GatewayClient;
  gatewayUrl?: string;
  logger?: Logger;
  timeoutMs?: number;
}

export async function ensureGateway(opts: EnsureGatewayOptions = {}): Promise<boolean> {
  const gateway = opts.gateway ?? new GatewayClient({ baseUrl: opts.gatewayUrl });
  const logger = opts.logger;
  if (await gateway.isHealthy(opts.timeoutMs ?? 3_000)) return true;

  logger?.warn?.(
    `Gateway not running at ${gateway.baseUrl}. ` +
      "Start it manually with: node --import tsx src/gateway/server.ts",
  );
  return false;
}
