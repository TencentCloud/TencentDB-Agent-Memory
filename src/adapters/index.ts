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

// MCP adapter (Pattern C — in-process TdaiCore wrapped as MCP server)
export { McpHostAdapter, createStderrLogger } from "./mcp/index.js";
export type { McpHostAdapterOptions } from "./mcp/index.js";

// PlatformAdapter SDK (拓展档 — new platforms implement ONE interface)
export type {
  IPlatformAdapter,
  IPlatformAdapterContext,
  PlatformToolDefinition,
  PlatformLifecycleEvent,
  PlatformLifecycleHandler,
  PlatformAdapterBootstrapOptions,
  ToolRouteTarget,
} from "./sdk/index.js";
export { PlatformAdapterRuntime } from "./sdk/index.js";
