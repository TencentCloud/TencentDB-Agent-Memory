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

// Gateway Client (shared infra)
export { GatewayClient, GatewayError } from "./shared/gateway-client.js";
export type { GatewayClientOptions } from "./shared/gateway-client.js";

// Circuit Breaker
export { CircuitBreaker, CircuitBreakerOpenError, CircuitState } from "./shared/circuit-breaker.js";
export type { CircuitBreakerOptions } from "./shared/circuit-breaker.js";

// Retry
export { withRetry, computeBackoff } from "./shared/retry.js";
export type { RetryOptions } from "./shared/retry.js";

// Transport layer (v2)
export { MemoryClientError, HttpMemoryClient, InProcessMemoryClient } from "./shared/transports/index.js";
export type { MemoryClient } from "./shared/transports/types.js";

// Factory (v2)
export { createMemoryClient, createMemoryClientFromEnv } from "./factory.js";
export type { TransportConfig } from "./factory.js";

// OpenCode adapter (v2)
export { OpenCodeMemoryAdapter } from "./opencode/index.js";
export type { OpenCodeAdapterOptions } from "./opencode/index.js";
