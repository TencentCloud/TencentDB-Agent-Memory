/**
 * TDAI Adapters — barrel re-export for all host adapter implementations.
 *
 * Core host adapters provide runtime capabilities to TdaiCore. Lifecycle
 * platform adapters translate platform hooks into the shared adapter SDK.
 *
 * Directory structure:
 *   adapters/
 *   ├── openclaw/      — OpenClaw plugin host (in-process, runEmbeddedPiAgent)
 *   ├── standalone/    — Gateway / Hermes sidecar (HTTP, OpenAI-compatible API)
 *   └── sdk/           — Public lifecycle adapter contract and runtime
 */

export {
	createAdapterRuntime,
	createGatewayMemoryClient,
	defaultAdapterOperationStateDir,
	ExternalAdapterOperationStore,
	FileAdapterOperationStore,
} from "./sdk/index.js";
export type {
	AdapterOperationStore,
	AdapterRuntime,
	AdapterRuntimeOptions,
	MemoryClient,
	PlatformAdapter,
} from "./sdk/index.js";

export { CodexPlatformAdapter } from "./codex/index.js";
export { ClaudeCodePlatformAdapter } from "./claude-code/index.js";
export { OpenCodePlatformAdapter } from "./opencode/plugin.js";

// OpenClaw adapter
export { OpenClawHostAdapter, OpenClawLLMRunner, OpenClawLLMRunnerFactory } from "./openclaw/index.js";
export type { OpenClawHostAdapterOptions, OpenClawLLMRunnerFactoryOptions } from "./openclaw/index.js";

// Standalone adapter
export { StandaloneHostAdapter, StandaloneLLMRunner, StandaloneLLMRunnerFactory } from "./standalone/index.js";
export type { StandaloneHostAdapterOptions, StandaloneLLMConfig, StandaloneLLMRunnerFactoryOptions } from "./standalone/index.js";
