import type { GatewayMemoryClientOptions } from "./types.js";

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8420";

export function gatewayClientOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): GatewayMemoryClientOptions {
  const timeoutRaw = env.TDAI_GATEWAY_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;
  return {
    baseUrl: env.TDAI_GATEWAY_URL?.trim() || DEFAULT_GATEWAY_URL,
    apiKey: env.TDAI_GATEWAY_API_KEY,
    timeoutMs,
    allowRemote: /^(1|true|yes)$/i.test(env.TDAI_GATEWAY_ALLOW_REMOTE?.trim() ?? ""),
  };
}
