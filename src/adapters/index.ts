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
 */

// OpenClaw adapter
export { OpenClawHostAdapter, OpenClawLLMRunner, OpenClawLLMRunnerFactory } from "./openclaw/index.js";
export type { OpenClawHostAdapterOptions, OpenClawLLMRunnerFactoryOptions } from "./openclaw/index.js";

// Standalone adapter
export { StandaloneHostAdapter, StandaloneLLMRunner, StandaloneLLMRunnerFactory } from "./standalone/index.js";
export type { StandaloneHostAdapterOptions, StandaloneLLMConfig, StandaloneLLMRunnerFactoryOptions } from "./standalone/index.js";

// Gateway client SDK for cross-platform integrations
export { TdaiGatewayClient, GatewayClientError, createGatewaySessionKey } from "./gateway-client.js";
export type {
  GatewayFetch,
  GatewayFetchResponse,
  GatewayRequestInit,
  GatewaySessionKeyParts,
  TdaiGatewayClientOptions,
} from "./gateway-client.js";

// Dify Workflow adapter
export { DifyWorkflowMemoryAdapter, createDifyWorkflowMemoryAdapter } from "./dify/index.js";
export type {
  DifyCaptureResult,
  DifyRecallResult,
  DifyWorkflowInput,
  DifyWorkflowMemoryAdapterOptions,
  GatewayMemoryClient,
} from "./dify/index.js";
