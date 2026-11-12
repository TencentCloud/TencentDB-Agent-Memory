/**
 * TDAI Adapter SDK — barrel export.
 *
 * A zero-dependency Node.js SDK for onboarding new AI platforms onto
 * TencentDB Agent Memory (TDAI) via the TdaiGateway HTTP API.
 *
 * See README.md for the standard interface and the 3-step onboarding guide.
 */

export {
  DEFAULT_GATEWAY_URL,
  DEFAULT_TIMEOUT_MS,
  resolveConfig,
} from "./config.js";
export { silentLogger, createLogger } from "./logger.js";
export { TdaiGatewayClient, TdaiGatewayError } from "./gateway-client.js";
export { BasePlatformAdapter, defineAdapter } from "./platform-adapter.js";
export {
  readStdin,
  runHealthHook,
  runRecallHook,
  runCaptureHook,
  runSessionEndHook,
} from "./hook-runner.js";
export { createMcpBridge } from "./mcp-bridge.js";
