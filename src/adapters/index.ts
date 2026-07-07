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
 *   └── coding-agent/   — Gateway client for coding-agent hosts (Codex, Claude Code, Cursor)
 */

// OpenClaw adapter
export { OpenClawHostAdapter, OpenClawLLMRunner, OpenClawLLMRunnerFactory } from "./openclaw/index.js";
export type { OpenClawHostAdapterOptions, OpenClawLLMRunnerFactoryOptions } from "./openclaw/index.js";

// Standalone adapter
export { StandaloneHostAdapter, StandaloneLLMRunner, StandaloneLLMRunnerFactory } from "./standalone/index.js";
export type { StandaloneHostAdapterOptions, StandaloneLLMConfig, StandaloneLLMRunnerFactoryOptions } from "./standalone/index.js";

// Coding-agent Gateway client
export { CodingAgentGatewayClient, CodingAgentGatewayError } from "./coding-agent/index.js";
export type {
  CodingAgentConversationSearchRequest,
  CodingAgentGatewayClientOptions,
  CodingAgentMemorySearchRequest,
  CodingAgentRecallRequest,
  CodingAgentTurn,
} from "./coding-agent/index.js";
