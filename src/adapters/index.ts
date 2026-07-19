/**
 * TDAI Adapters — barrel re-export for all host adapter implementations.
 *
 * Each adapter translates a specific host environment's API into
 * the host-neutral HostAdapter interface consumed by TdaiCore.
 *
 * Directory structure:
 *   adapters/
 *   ├── openclaw/      — OpenClaw plugin host (in-process, runEmbeddedPiAgent)
 *   ├── standalone/    — Gateway / Hermes sidecar (HTTP, OpenAI-compatible API)
 *   ├── sdk/           — Shared Gateway adapter SDK for platform wrappers
 *   ├── codex/         — Codex-facing Gateway client
 *   ├── codebuddy/     — CodeBuddy-facing Gateway client
 *   └── claude-code/   — Claude Code-facing Gateway client
 */

// OpenClaw adapter
export { OpenClawHostAdapter, OpenClawLLMRunner, OpenClawLLMRunnerFactory } from "./openclaw/index.js";
export type { OpenClawHostAdapterOptions, OpenClawLLMRunnerFactoryOptions } from "./openclaw/index.js";

// Standalone adapter
export { StandaloneHostAdapter, StandaloneLLMRunner, StandaloneLLMRunnerFactory } from "./standalone/index.js";
export type { StandaloneHostAdapterOptions, StandaloneLLMConfig, StandaloneLLMRunnerFactoryOptions } from "./standalone/index.js";

// Shared Gateway SDK
export {
  GatewayMemoryAdapter,
  createGatewayAdapterOptions,
  createMemoryAdapter,
  createPlatformMemoryAdapter,
  getMemoryPlatformAdapter,
  listMemoryAdapterProviders,
  registerMemoryPlatformAdapter,
} from "./sdk/index.js";
export type {
  GatewayCaptureParams,
  GatewayConversationSearchParams,
  GatewayMemoryAdapterOptions,
  GatewayMemorySearchParams,
  GatewayRecallParams,
  MemoryAdapterConfig,
  MemoryAdapterProviderConfig,
  MemoryPlatformAdapterDefinition,
  MemoryAdapterPlatform,
  PlatformAdapterDefaults,
  PlatformEnv,
} from "./sdk/index.js";

// Codex adapter
export { CodexMemoryGatewayClient, CodexMemoryPlatformAdapter } from "./codex/index.js";
export type {
  CodexCaptureParams,
  CodexConversationSearchParams,
  CodexMemoryGatewayClientEnv,
  CodexMemoryGatewayClientOptions,
  CodexMemorySearchParams,
  CodexRecallParams,
} from "./codex/index.js";

// CodeBuddy adapter
export { CodeBuddyMemoryAdapter, CodeBuddyMemoryPlatformAdapter } from "./codebuddy/index.js";
export type {
  CodeBuddyMemoryAdapterEnv,
  CodeBuddyMemoryAdapterOptions,
} from "./codebuddy/index.js";

// Claude Code adapter
export { ClaudeCodeMemoryAdapter, ClaudeCodeMemoryPlatformAdapter } from "./claude-code/index.js";
export type {
  ClaudeCodeMemoryAdapterEnv,
  ClaudeCodeMemoryAdapterOptions,
} from "./claude-code/index.js";
