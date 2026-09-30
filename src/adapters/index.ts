/**
 * TDAI Adapters - barrel re-export for all host adapter implementations.
 *
 * Each adapter translates a specific host environment API into the integration
 * shape needed to reach TdaiCore.
 *
 * Directory structure:
 *   adapters/
 *   - openclaw/     OpenClaw plugin host (in-process, runEmbeddedPiAgent)
 *   - standalone/   Gateway / Hermes sidecar (HTTP, OpenAI-compatible API)
 *   - claude-code/  Claude Code hooks, MCP search tools, and short-term canvas capture
 *   - pi-agent/     Pi Agent extension lifecycle hooks and custom memory tools
 */

// OpenClaw adapter
export { OpenClawHostAdapter, OpenClawLLMRunner, OpenClawLLMRunnerFactory } from "./openclaw/index.js";
export type { OpenClawHostAdapterOptions, OpenClawLLMRunnerFactoryOptions } from "./openclaw/index.js";

// Standalone adapter
export { StandaloneHostAdapter, StandaloneLLMRunner, StandaloneLLMRunnerFactory } from "./standalone/index.js";
export type { StandaloneHostAdapterOptions, StandaloneLLMConfig, StandaloneLLMRunnerFactoryOptions } from "./standalone/index.js";

// Claude Code adapter
export * from "./claude-code/index.js";

// Pi Agent adapter
export * from "./pi-agent/index.js";
