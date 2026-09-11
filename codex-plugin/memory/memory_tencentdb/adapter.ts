import {
  GatewayMemoryClient,
  createGatewayPlatformAdapter,
  type GatewayMemoryClientOptions,
  type GatewayPlatformAdapter,
} from "../../../src/adapters/gateway-client/index.js";

export interface CodexMemoryAdapterOptions
  extends Partial<Omit<GatewayMemoryClientOptions, "baseUrl">> {
  baseUrl?: string;
}

export function createCodexMemoryAdapter(
  sessionId: string,
  opts: CodexMemoryAdapterOptions = {},
): GatewayPlatformAdapter {
  const client = new GatewayMemoryClient({
    baseUrl: opts.baseUrl ?? process.env.TDAI_GATEWAY_URL ?? "http://127.0.0.1:8420",
    apiKey: opts.apiKey ?? process.env.TDAI_GATEWAY_API_KEY,
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  });

  return createGatewayPlatformAdapter({
    client,
    platform: "codex",
    resolveContext: () => ({ sessionKey: sessionId, sessionId }),
  });
}
