/**
 * TDAI Adapters — barrel re-export for all host adapter implementations.
 *
 * Each adapter translates a specific host environment's API into
 * the host-neutral HostAdapter interface consumed by TdaiCore.
 */

// OpenClaw adapter
export { OpenClawHostAdapter, OpenClawLLMRunner, OpenClawLLMRunnerFactory } from "./openclaw/index.js";
export type { OpenClawHostAdapterOptions, OpenClawLLMRunnerFactoryOptions } from "./openclaw/index.js";

// Standalone adapter
export { StandaloneHostAdapter, StandaloneLLMRunner, StandaloneLLMRunnerFactory } from "./standalone/index.js";
export type { StandaloneHostAdapterOptions, StandaloneLLMConfig, StandaloneLLMRunnerFactoryOptions } from "./standalone/index.js";

// -- Cross-Platform Adapters (Issue #235) --

// Shared infrastructure
export { GatewayClient, GatewayError, CircuitBreakerOpenError } from "./shared/gateway-client.js";
export type { GatewayClientOptions, HealthResponse, RecallResponse, CaptureResponse, SearchResponse } from "./shared/gateway-client.js";
export { withRetry, computeBackoff } from "./shared/retry.js";
export type { RetryOptions } from "./shared/retry.js";
export { CircuitBreaker, CircuitState } from "./shared/circuit-breaker.js";
export type { CircuitBreakerOptions } from "./shared/circuit-breaker.js";

// Platform adapter interface
export { BaseMemoryPlatformAdapter } from "./memory-platform-adapter.js";
export type {
  MemoryPlatformAdapter,
  MemoryRecallResult,
  MemoryCaptureResult,
  MemorySearchResult,
  MemoryHealthResult,
} from "./memory-platform-adapter.js";

// MCP adapter
export { McpMemoryAdapter, McpServer, ErrorCode, TDAI_TOOLS } from "./mcp/index.js";
export type {
  McpServerOptions,
  JsonRpcRequest,
  JsonRpcResponse,
  McpToolDefinition,
  ToolsListResult,
  ToolsCallResult,
} from "./mcp/index.js";

// Codex adapter
export {
  CodexMemoryAdapter,
  generateRecallHook,
  generateCaptureHook,
  generateCodexHookConfig,
  generateCodexMcpConfig,
  getCodexTools,
} from "./codex/index.js";
export type { CodexHookContext, CodexHookConfig, CodexMcpConfig } from "./codex/index.js";

// Claude Code adapter
export {
  ClaudeCodeMemoryAdapter,
  generateBeforeRecallHook,
  generateAfterCaptureHook,
  generateStopHook,
  generateClaudeCodeHookConfig,
  generateClaudeCodeMcpConfig,
} from "./claude-code/index.js";
export type { ClaudeCodeHookConfig, ClaudeCodeMcpConfig } from "./claude-code/index.js";

// Dify adapter
export { DifyMemoryAdapter, generateDifyOpenApiSpec } from "./dify/index.js";

// REST adapter
export { RestMemoryAdapter } from "./rest/index.js";

// -- Transport Layer + New Adapters (Issue #235 Round 2) --

// Transport layer
export { MemoryClientError, HttpMemoryClient, InProcessMemoryClient } from "./shared/transports/index.js";
export type { MemoryClient } from "./shared/transports/types.js";

// Factory
export { createMemoryClient, createMemoryClientFromEnv } from "./factory.js";
export type { TransportConfig } from "./factory.js";

// OpenCode adapter
export { OpenCodeMemoryAdapter } from "./opencode/index.js";
export type { OpenCodeAdapterOptions } from "./opencode/index.js";
