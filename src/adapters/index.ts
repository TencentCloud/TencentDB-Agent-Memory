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
 *   ├── hermes/        — Hermes Agent platform adapter
 *   ├── claude-code/   — Claude Code CLI adapter
 *   └── sdk/          — PlatformAdapter SDK (unified interface for new platforms)
 */

// OpenClaw adapter
export { OpenClawHostAdapter, OpenClawLLMRunner, OpenClawLLMRunnerFactory } from "./openclaw/index.js";
export type { OpenClawHostAdapterOptions, OpenClawLLMRunnerFactoryOptions } from "./openclaw/index.js";

// OpenClaw PlatformAdapter (SKILL implementations)
export { OpenClawAdapter } from "./openclaw/openclaw-adapter.js";

// Standalone adapter
export { StandaloneHostAdapter, StandaloneLLMRunner, StandaloneLLMRunnerFactory } from "./standalone/index.js";
export type { StandaloneHostAdapterOptions, StandaloneLLMConfig, StandaloneLLMRunnerFactoryOptions } from "./standalone/index.js";

// Hermes adapter
export { HermesAdapter } from "./hermes/hermes-adapter.js";

// Claude Code adapter
export { ClaudeCodeAdapter } from "./claude-code/claude-code-adapter.js";

// SDK exports (PlatformAdapter interface and utilities)
export { PlatformAdapter } from "./sdk/platform-adapter.interface.js";
export type {
  AdapterConfig,
  InstallOptions,
  DiagnosticExportOptions,
  PlatformCapabilities,
  MemorySearchResult,
  ConversationSearchResult,
} from "./sdk/platform-adapter.interface.js";

export { BasePlatformAdapter, AdapterLifecycleState } from "./sdk/base-adapter.js";
export type { BasePlatformAdapterOptions, RetryOptions } from "./sdk/base-adapter.js";

export { DefaultToolRegistry } from "./sdk/tool-registry.js";
export type { ToolDefinition, ToolCallContext, ToolInterceptor, ToolRegistryOptions } from "./sdk/tool-registry.js";

export { DefaultLifecycleManager, LifecycleState } from "./sdk/lifecycle-manager.js";
export type { HealthCheckResult, HealthCheck, LifecycleHooks, LifecycleManagerOptions } from "./sdk/lifecycle-manager.js";

export { DefaultEventEmitter, ADAPTER_EVENTS } from "./sdk/event-emitter.js";
export type { EventHandler, EventEmitterOptions, AdapterEventType } from "./sdk/event-emitter.js";

export { DefaultConfigValidator } from "./sdk/config-validator.js";
export type { ValidationRule, ValidationError, ValidationWarning, ValidationResult, ConfigValidatorOptions } from "./sdk/config-validator.js";

export { DefaultErrorHandler, TdaiAdapterError, ERROR_CODES } from "./sdk/error-handler.js";
export type { ErrorCode, RetryConfig, ErrorHandlerOptions } from "./sdk/error-handler.js";
