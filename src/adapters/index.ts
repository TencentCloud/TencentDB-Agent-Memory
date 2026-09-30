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

// Platform adapters
export { MemoryGatewayClient, type MemoryGatewayClientOptions, type MemoryRecallContext } from "./platform/gateway-client.js";
export { MemoryPlatformAdapter, createMemoryPlatformAdapter, type MemoryAdapterOptions } from "./platform/memory-adapter.js";
export {
  normalizeSessionPart,
  type MemoryAdapterRuntime,
  type MemoryPlatformBridge,
  type MemoryPromptContext,
  type MemoryTurnPayload,
} from "./platform/bridge.js";

// Codex adapter
export { CodexMemoryAdapter, CodexMemoryBridge, createCodexMemoryAdapter } from "./codex/index.js";
export type { CodexMemoryAdapterOptions, CodexPromptContext } from "./codex/index.js";

// Dify adapter
export { DifyMemoryAdapter, DifyMemoryBridge, createDifyMemoryAdapter } from "./dify/index.js";
export type { DifyMemoryAdapterOptions, DifyPromptContext, DifyRequestContext, DifyTurnPayload } from "./dify/index.js";
