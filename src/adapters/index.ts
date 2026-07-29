/**
 * TDAI Adapters — barrel re-export for all host adapter implementations.
 *
 * Each adapter translates a specific host environment's API into
 * the host-neutral HostAdapter interface consumed by TdaiCore.
 *
 * Directory structure:
 *   adapters/
 *   ├── openclaw/       — OpenClaw plugin host (in-process, runEmbeddedPiAgent)
 *   ├── standalone/     — Gateway / Hermes sidecar (HTTP, OpenAI-compatible API)
 *   ├── coding-agent/   — Unified coding-agent adapter SDK: Gateway client +
 *   │                     CodingAgentPlatformAdapter interface + runCodingAgentAdapter
 *   └── claude-code/    — Claude Code binding (reference CodingAgentPlatformAdapter impl)
 */

// OpenClaw adapter
export { OpenClawHostAdapter, OpenClawLLMRunner, OpenClawLLMRunnerFactory } from "./openclaw/index.js";
export type { OpenClawHostAdapterOptions, OpenClawLLMRunnerFactoryOptions } from "./openclaw/index.js";

// Standalone adapter
export { StandaloneHostAdapter, StandaloneLLMRunner, StandaloneLLMRunnerFactory } from "./standalone/index.js";
export type { StandaloneHostAdapterOptions, StandaloneLLMConfig, StandaloneLLMRunnerFactoryOptions } from "./standalone/index.js";

// Coding-agent Gateway client + unified platform adapter SDK
export {
  CodingAgentGatewayClient,
  CodingAgentGatewayError,
  combineRecallContext,
  runCodingAgentAdapter,
} from "./coding-agent/index.js";
export type {
  CodingAgentAdapterOptions,
  CodingAgentAdapterResult,
  CodingAgentClient,
  CodingAgentConversationSearchRequest,
  CodingAgentEvent,
  CodingAgentGatewayClientOptions,
  CodingAgentMemorySearchRequest,
  CodingAgentPlatformAdapter,
  CodingAgentRecallLike,
  CodingAgentRecallRequest,
  CodingAgentTurn,
} from "./coding-agent/index.js";

// Claude Code hook adapter (reference implementation of CodingAgentPlatformAdapter)
export { buildSessionKey, claudeCodeAdapter, extractLatestTurn, handleClaudeCodeHook } from "./claude-code/index.js";
export type {
  ClaudeCodeHookClient,
  ClaudeCodeHookInput,
  ClaudeCodeHookOptions,
  ClaudeCodeHookResult,
  TranscriptTurn,
} from "./claude-code/index.js";
