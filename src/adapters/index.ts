/**
 * TDAI Adapters — barrel re-export for all host adapter implementations.
 *
 * Each adapter translates a specific host environment's API into
 * the host-neutral HostAdapter interface consumed by TdaiCore.
 *
 * Directory structure:
 *   adapters/
 *   ├── openclaw/      — OpenClaw plugin host (in-process, runEmbeddedPiAgent)
 *   └── standalone/    — Gateway / Hermes sidecar (HTTP, OpenAI-compatible API)
 *   └── gateway-client/ — Generic HTTP client for new platform adapters
 */

// OpenClaw adapter
export { OpenClawHostAdapter, OpenClawLLMRunner, OpenClawLLMRunnerFactory } from "./openclaw/index.js";
export type { OpenClawHostAdapterOptions, OpenClawLLMRunnerFactoryOptions } from "./openclaw/index.js";

// Standalone adapter
export { StandaloneHostAdapter, StandaloneLLMRunner, StandaloneLLMRunnerFactory } from "./standalone/index.js";
export type { StandaloneHostAdapterOptions, StandaloneLLMConfig, StandaloneLLMRunnerFactoryOptions } from "./standalone/index.js";

// Gateway client adapter
export {
  GatewayMemoryClient,
  GatewayMemoryClientError,
  createGatewayPlatformAdapter,
} from "./gateway-client/index.js";
export type {
  GatewayMemoryClientOptions,
  GatewayPlatformAdapter,
  GatewayPlatformAdapterOptions,
  GatewayPlatformContext,
} from "./gateway-client/index.js";

// Mastra processor adapter
export {
  createMastraMemoryProcessor,
  flushMastraSession,
} from "./mastra/index.js";
export type {
  FlushMastraSessionOptions,
  MastraMemoryAdapterError,
  MastraMemoryProcessorOptions,
} from "./mastra/index.js";
