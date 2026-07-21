/**
 * TDAI Adapter SDK — public barrel.
 *
 * Add a new Agent platform in ~30 lines: implement `PlatformBinding`, then
 * construct `MemoryAdapter` with a `GatewayClient` and call `handleRecall` /
 * `handleCapture` / `handleSessionEnd` / `handleToolCall` from the platform's
 * lifecycle events. See `bindings/claude-code` for a full example and
 * `bindings/codex` for a minimal one.
 */

export { MemoryAdapter } from "./adapter-core.js";
export type { MemoryAdapterOptions } from "./adapter-core.js";

export { GatewayClient, GatewayError } from "./gateway-client.js";
export type { GatewayClientOptions, HealthResult } from "./gateway-client.js";

export { resolveGatewayConfig } from "./config.js";
export type { ResolvedGatewayConfig } from "./config.js";

export type {
  PlatformBinding,
  AdapterLogger,
  ToolDescriptor,
  ToolName,
  RecallInput,
  RecallOutput,
  CaptureInput,
  CaptureOutput,
  SessionEndInput,
  MemorySearchInput,
  ConversationSearchInput,
  SearchOutput,
} from "./types.js";

/** Convenience: build a MemoryAdapter from env + a binding in one call. */
import { MemoryAdapter } from "./adapter-core.js";
import { GatewayClient } from "./gateway-client.js";
import { resolveGatewayConfig } from "./config.js";
import type { PlatformBinding, AdapterLogger } from "./types.js";

export function createAdapterFromEnv(
  binding: PlatformBinding,
  logger?: AdapterLogger,
): MemoryAdapter {
  const cfg = resolveGatewayConfig();
  const client = new GatewayClient({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    logger,
  });
  return new MemoryAdapter({ binding, client, logger });
}
