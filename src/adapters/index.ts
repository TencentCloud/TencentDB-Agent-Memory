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

// Claude Code adapter
export { CCHostAdapter } from "./claude-code/index.js";
export type { CCHostAdapterOptions } from "./claude-code/index.js";

// CodeBuddy adapter
export { CodeBuddyHostAdapter } from "./codebuddy/index.js";
export type { CodeBuddyHostAdapterOptions } from "./codebuddy/index.js";

// Shared types
export type {
  PlatformAdapterOptions,
  PlatformTool,
  PlatformToolParam,
  PlatformLifecycle,
} from "./shared/index.js";
export { TDAI_TOOLS } from "./shared/index.js";
