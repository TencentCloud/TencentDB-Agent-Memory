import {
  GatewayMemoryClient,
  createGatewayPlatformAdapter,
  type GatewayMemoryClientOptions,
  type GatewayPlatformAdapter,
} from "../../../src/adapters/gateway-client/index.js";

export interface ClaudeCodeMemoryAdapterOptions
  extends Partial<Omit<GatewayMemoryClientOptions, "baseUrl">> {
  baseUrl?: string;
}

export function createClaudeCodeGatewayClient(
  opts: ClaudeCodeMemoryAdapterOptions = {},
): GatewayMemoryClient {
  return new GatewayMemoryClient({
    baseUrl: opts.baseUrl ?? process.env.TDAI_GATEWAY_URL ?? "http://127.0.0.1:8420",
    apiKey: opts.apiKey ?? process.env.TDAI_GATEWAY_API_KEY,
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  });
}

export function createClaudeCodeMemoryAdapter(
  sessionId: string,
  opts: ClaudeCodeMemoryAdapterOptions = {},
): GatewayPlatformAdapter {
  const client = createClaudeCodeGatewayClient(opts);

  return createGatewayPlatformAdapter({
    client,
    platform: "claude-code",
    resolveContext: () => ({ sessionKey: sessionId, sessionId }),
  });
}
