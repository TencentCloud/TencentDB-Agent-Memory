/**
 * Gemini CLI adapter - barrel exports.
 */
export { TdaiGatewayClient, resolveGatewayClientOptions } from "./gateway-client.js";
export type {
  TdaiGatewayClientOptions,
  TdaiGatewayClientLike,
  TdaiGatewayRecallResult,
  TdaiGatewayCaptureResult,
  TdaiGatewaySessionEndResult,
} from "./gateway-client.js";
export { handleGeminiCliHook } from "./hook-handler.js";
export type { GeminiHookInput, GeminiHookOutput, GeminiHookLogger } from "./hook-handler.js";
