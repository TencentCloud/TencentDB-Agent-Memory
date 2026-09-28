/**
 * TDAI Adapters — barrel re-export for all host adapter implementations.
 *
 * Each adapter translates a specific host environment's API into
 * the host-neutral HostAdapter interface consumed by TdaiCore,
 * or maps platform lifecycle hooks onto the Gateway HTTP API.
 *
 * Directory structure:
 *   adapters/
 *   ├── openclaw/        — OpenClaw plugin host (in-process)
 *   ├── standalone/      — Gateway / Hermes sidecar (HTTP)
 *   ├── gateway-client/  — shared HTTP client for cross-platform hosts
 *   └── mimo-code/       — MiMo Code plugin (Gateway-backed)
 */

// OpenClaw adapter
export { OpenClawHostAdapter, OpenClawLLMRunner, OpenClawLLMRunnerFactory } from "./openclaw/index.js";
export type { OpenClawHostAdapterOptions, OpenClawLLMRunnerFactoryOptions } from "./openclaw/index.js";

// Standalone adapter
export { StandaloneHostAdapter, StandaloneLLMRunner, StandaloneLLMRunnerFactory } from "./standalone/index.js";
export type { StandaloneHostAdapterOptions, StandaloneLLMConfig, StandaloneLLMRunnerFactoryOptions } from "./standalone/index.js";

// Gateway client kit (cross-platform)
export {
  GatewayConfigurationError,
  GatewayMemoryClient,
  GatewayMemoryClientError,
  GatewayRedirectError,
  GatewayResponseError,
  GatewayTimeoutError,
  GatewayTransportError,
  createGatewayPlatformAdapter,
} from "./gateway-client/index.js";
export type {
  GatewayMemoryClientOptions,
  GatewayPlatformAdapter,
  GatewayPlatformAdapterOptions,
  GatewayPlatformContext,
} from "./gateway-client/index.js";

// MiMo Code plugin adapter
export {
  buildMimoCodeSessionKey,
  createMimoCodeMemoryPlugin,
  extractMimoCodePrompt,
  formatMimoCodeRecall,
  latestMimoCodeTrajectoryText,
  resolveMimoCodeGatewayApiKey,
} from "./mimo-code/index.js";
export type {
  MimoCodeMemoryPlugin,
  MimoCodeMemoryPluginOptions,
  MimoCodeMessage,
  MimoCodePluginContext,
  MimoCodePluginHooks,
  MimoCodeTextPart,
  MimoCodeTrajectoryMessage,
} from "./mimo-code/index.js";
