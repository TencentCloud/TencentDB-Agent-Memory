/**
 * Codex adapter — barrel exports.
 *
 * This is the single import point for integrating the TDAI memory engine
 * with the OpenAI Codex CLI:
 *
 *   ```typescript
 *   import {
 *     createCodexAdapter,
 *     CodexHooks,
 *     createCodexHooks,
 *   } from "./codex/index.js";
 *   ```
 *
 * Exports:
 * - `CodexAdapter` — Main adapter class extending `MemoryAdapterBase`.
 * - `createCodexAdapter` — Factory function (reads config from env vars).
 * - `CodexHooks` — Lifecycle hook manager for Codex's hook-based API.
 * - `createCodexHooks` — Convenience factory combining adapter + hooks.
 * - Types: `CodexMessage`, `CodexAdapterConfig`, hook result/handler types.
 * - Tool definitions: `CODEX_MEMORY_SEARCH_TOOL`, etc.
 */

// Adapter
export { CodexAdapter, createCodexAdapter, resolveCodexConfig } from "./codex-adapter.js";
export type {
  CodexMessage,
  CodexAdapterConfig,
} from "./codex-adapter.js";

// Tool definitions
export {
  CODEX_MEMORY_SEARCH_TOOL,
  CODEX_CONVERSATION_SEARCH_TOOL,
  CODEX_READ_SCENE_TOOL,
} from "./codex-adapter.js";

// Hooks
export {
  CodexHooks,
  createCodexHooks,
} from "./hooks.js";
export type {
  BeforePromptBuildResult,
  AfterResponseResult,
  OnToolCallResult,
  BeforePromptBuildHandler,
  AfterResponseHandler,
  OnToolCallHandler,
} from "./hooks.js";
