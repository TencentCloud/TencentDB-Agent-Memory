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

// —— 跨平台适配器（Issue #235） ——

// 共享基础设施
export { GatewayClient, GatewayError, CircuitBreakerOpenError } from "./shared/gateway-client.js";
export type { GatewayClientOptions, HealthResponse, RecallResponse, CaptureResponse, SearchResponse } from "./shared/gateway-client.js";
export { withRetry, computeBackoff } from "./shared/retry.js";
export type { RetryOptions } from "./shared/retry.js";
export { CircuitBreaker, CircuitState } from "./shared/circuit-breaker.js";
export type { CircuitBreakerOptions } from "./shared/circuit-breaker.js";

// 平台适配器接口
export { BaseMemoryPlatformAdapter } from "./memory-platform-adapter.js";
export type {
  MemoryPlatformAdapter,
  MemoryRecallResult,
  MemoryCaptureResult,
  MemorySearchResult,
  MemoryHealthResult,
} from "./memory-platform-adapter.js";

// MCP 适配器
export { McpMemoryAdapter, McpServer, ErrorCode, TDAI_TOOLS } from "./mcp/index.js";
export type {
  McpServerOptions,
  JsonRpcRequest,
  JsonRpcResponse,
  McpToolDefinition,
  ToolsListResult,
  ToolsCallResult,
} from "./mcp/index.js";

// Codex 适配器
export {
  CodexMemoryAdapter,
  generateRecallHook,
  generateCaptureHook,
  generateCodexHookConfig,
  generateCodexMcpConfig,
  getCodexTools,
} from "./codex/index.js";
export type { CodexHookContext, CodexHookConfig, CodexMcpConfig } from "./codex/index.js";

// Claude Code 适配器
export {
  ClaudeCodeMemoryAdapter,
  generateBeforeRecallHook,
  generateAfterCaptureHook,
  generateStopHook,
  generateClaudeCodeHookConfig,
  generateClaudeCodeMcpConfig,
} from "./claude-code/index.js";
export type { ClaudeCodeHookConfig, ClaudeCodeMcpConfig } from "./claude-code/index.js";

// Dify 适配器
export { DifyMemoryAdapter, generateDifyOpenApiSpec } from "./dify/index.js";

// REST 适配器
export { RestMemoryAdapter } from "./rest/index.js";
