/**
 * TDAI Adapters — barrel re-export for all host adapter implementations.
 *
 * Each adapter translates a specific host environment's API into
 * the host-neutral interface consumed by TdaiCore or the Gateway.
 *
 * Directory structure:
 *   adapters/
 *   ├── sdk/           — Unified Adapter SDK (MemoryAdapterBase, types, Gateway client)
 *   ├── claude-code/   — Claude Code MCP adapter (stdio JSON-RPC)
 *   ├── codex/         — Codex CLI adapter (lifecycle hooks)
 *   ├── openclaw/      — OpenClaw plugin host (in-process, runEmbeddedPiAgent)
 *   └── standalone/    — Gateway / Hermes sidecar (HTTP, OpenAI-compatible API)
 *
 * New platforms should extend `MemoryAdapterBase` from `./sdk/index.js` and
 * implement the 4 abstract methods. See `docs/adaptation-guide.md`.
 */

// ── Unified Adapter SDK ──────────────────────────────────────────
export { MemoryAdapterBase, DEFAULT_MEMORY_SEARCH_TOOL, DEFAULT_CONVERSATION_SEARCH_TOOL, DEFAULT_READ_SCENE_TOOL } from "./sdk/index.js";
export { MemoryGatewayClient } from "./sdk/index.js";
export type {
  GatewayConnectionConfig,
  TenancyConfig,
  AdapterConfig,
  ConversationMessage,
  MemoryItem,
  PersonaContent,
  SceneEntry,
  RecallResult,
  CaptureResult,
  SearchResult,
  ToolDefinition,
  IPlatformAdapter,
} from "./sdk/index.js";

// ── Claude Code MCP adapter ──────────────────────────────────────
export { ClaudeCodeAdapter, TdaiMcpServer, main } from "./claude-code/index.js";
export type { ClaudeCodeAdapterConfig, ClaudeMessage, ClaudeContentBlock } from "./claude-code/index.js";

// ── Codex CLI adapter ────────────────────────────────────────────
export { CodexAdapter, CodexHooks, createCodexAdapter, createCodexHooks, CODEX_MEMORY_SEARCH_TOOL, CODEX_CONVERSATION_SEARCH_TOOL, CODEX_READ_SCENE_TOOL } from "./codex/index.js";
export type { CodexAdapterConfig, CodexMessage, BeforePromptBuildResult, AfterResponseResult, OnToolCallResult } from "./codex/index.js";

// ── OpenClaw adapter (existing) ─────────────────────────────────
export { OpenClawHostAdapter, OpenClawLLMRunner, OpenClawLLMRunnerFactory } from "./openclaw/index.js";
export type { OpenClawHostAdapterOptions, OpenClawLLMRunnerFactoryOptions } from "./openclaw/index.js";

// ── Standalone adapter (existing) ───────────────────────────────
export { StandaloneHostAdapter, StandaloneLLMRunner, StandaloneLLMRunnerFactory } from "./standalone/index.js";
export type { StandaloneHostAdapterOptions, StandaloneLLMConfig, StandaloneLLMRunnerFactoryOptions } from "./standalone/index.js";
