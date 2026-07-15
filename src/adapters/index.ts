/**
 * TDAI Adapters — barrel re-export for all host adapter implementations.
 *
 * Each adapter translates a specific host environment's API into
 * the host-neutral HostAdapter interface consumed by TdaiCore
 * (Track 1, 进程内) 或 HostEventBinding 接口（Track 2, 进程外）。
 *
 * Directory structure:
 *   adapters/
 *   ├── openclaw/      — OpenClaw plugin host (in-process, runEmbeddedPiAgent)
 *   ├── standalone/    — Gateway / Hermes sidecar (HTTP, OpenAI-compatible API)
 *   └── claude-code/   — Claude Code MCP stdio server (Pattern B-MCP, HTTP client of Gateway)
 */

// OpenClaw adapter
export { OpenClawHostAdapter, OpenClawLLMRunner, OpenClawLLMRunnerFactory } from "./openclaw/index.js";
export type { OpenClawHostAdapterOptions, OpenClawLLMRunnerFactoryOptions } from "./openclaw/index.js";

// Standalone adapter
export { StandaloneHostAdapter, StandaloneLLMRunner, StandaloneLLMRunnerFactory } from "./standalone/index.js";
export type { StandaloneHostAdapterOptions, StandaloneLLMConfig, StandaloneLLMRunnerFactoryOptions } from "./standalone/index.js";

// Claude Code adapter (Pattern B-MCP)
export {
  ClaudeCodeEventBinding,
  GatewaySupervisor,
  loadClaudeCodeConfig,
  resolveSessionKey,
  dispatchToolCall,
  createMcpServer,
  runMcpServer,
  runRecallHook,
  runCaptureHook,
  extractLastTurn,
  runSessionEndHook,
} from "./claude-code/index.js";
export type { ClaudeCodeAdapterConfig, GatewaySupervisorOptions, ClaudeCodeHookInput } from "./claude-code/index.js";
