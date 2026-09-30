/**
 * Unified Adapter SDK — Barrel exports.
 *
 * This is the single import point for any new Agent platform that wants
 * to integrate with the TDAI memory engine:
 *
 *   ```typescript
 *   import {
 *     MemoryAdapterBase,
 *     MemoryGatewayClient,
 *     type AdapterConfig,
 *   } from "./sdk/index.js";
 *   ```
 *
 * New platforms only need to:
 *   1. Extend `MemoryAdapterBase`
 *   2. Implement 4 abstract methods
 *   3. Call `initialize()` → `recall()` / `capture()` / `searchMemories()`
 */

// Types
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
} from "./types.js";

// Gateway HTTP client
export { MemoryGatewayClient } from "./gateway-client.js";

// Base adapter class
export { MemoryAdapterBase } from "./base-adapter.js";
export {
  DEFAULT_MEMORY_SEARCH_TOOL,
  DEFAULT_CONVERSATION_SEARCH_TOOL,
  DEFAULT_READ_SCENE_TOOL,
  BREAKER_THRESHOLD,
  BREAKER_COOLDOWN_MS,
} from "./base-adapter.js";
