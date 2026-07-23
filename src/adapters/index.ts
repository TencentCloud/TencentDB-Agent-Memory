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

// Qwen Code adapter
export { QwenCodeGatewayClient, QwenCodeGatewayError, qwenCodeGatewayClientFromEnv } from "./qwen-code/index.js";
export { createQwenCodeSessionKey, getProjectIdForQwenCode, extractCompletedTurnsFromQwenTranscript, getLatestCompletedQwenTurn, hashQwenCodeTurn, handleQwenCodeHook, runQwenCodeHookCli } from "./qwen-code/index.js";
export type { QwenCodeGatewayClientOptions, QwenCodeHookHandlerOptions, QwenCodeAdapterEnv, QwenCodeAdapterLogger, QwenCodeCompletedTurn, QwenCodeHookEventName, QwenCodeHookInput, QwenCodeHookOutput } from "./qwen-code/index.js";
