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

// Claude Code MCP adapter
export { ClaudeCodeHostAdapter, ClaudeCodeMcpServer } from "./claude-code/index.js";
export type { ClaudeCodeHostAdapterOptions, ClaudeCodeMcpServerOptions } from "./claude-code/index.js";

// Cursor MCP adapter
export { CursorHostAdapter, CursorMcpServer } from "./cursor/index.js";
export type { CursorHostAdapterOptions, CursorMcpServerOptions } from "./cursor/index.js";

// Codex CLI MCP adapter
export { CodexHostAdapter, CodexMcpServer } from "./codex/index.js";
export type { CodexHostAdapterOptions, CodexMcpServerOptions } from "./codex/index.js";

// Shared adapter base (all platforms)
export { HostAdapterBase } from "./host-adapter-base.js";
export type { HostAdapterBaseOptions } from "./host-adapter-base.js";

// Transport-neutral memory operations facade
export { MemoryOperations, MemoryOperationError } from "./memory-operations.js";

// HTTP base layer (for HTTP/Plugin platforms)
export { HttpServerBase, parseJsonBody, sendJson, sendError } from "./http-server-base.js";
export type { HttpServerBaseOptions } from "./http-server-base.js";

// Dify HTTP adapter
export { DifyHostAdapter, DifyHttpServer } from "./dify/index.js";
export type { DifyHostAdapterOptions, DifyHttpServerOptions } from "./dify/index.js";
