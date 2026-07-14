/**
 * MemoryPlatformAdapter — Unified contract for integrating any host platform
 * with the TDAI four-layer memory system.
 *
 * ─── Design principle ─────────────────────────────────────────────────────
 *
 *   A platform implement this interface.  The SDK (MemoryPlugin) handles
 *   the rest:
 *
 *     ┌─────────────────────────────────────┐
 *     │         MemoryPlugin (SDK)          │
 *     │     (Gateway HTTP Client mode)      │
 *     │  ┌──────────┐  ┌─────────────────┐  │
 *     │  │GatewayMem│  │ cache / metrics  │  │
 *     │  │ Client   │  │ lifecycle mgmt   │  │
 *     │  └─────┬────┘  └─────────────────┘  │
 *     │        │ HTTP                       │
 *     └────────┼────────────────────────────┘
 *              │
 *     ┌────────┴────────────────────────────┐
 *     │      TDAI Gateway (daemon)           │
 *     │  ┌──────────┐  ┌──────────────────┐  │
 *     │  │ TdaiCore  │  │ SQLite / Vector  │  │
 *     │  │ (engine)  │  │ Pipeline mgmt    │  │
 *     │  └──────────┘  └──────────────────┘  │
 *     └──────────────────────────────────────┘
 *
 * ─── Integration path ────────────────────────────────────────────────────
 *
 *   The recommended integration path for new platforms is the Gateway HTTP
 *   API via GatewayMemoryClient (see src/adapters/gateway-client/). This
 *   keeps platform-specific code thin and avoids embedding TdaiCore.
 *
 *   MemoryPlatformAdapter can still be implemented directly by wrapping
 *   GatewayMemoryClient, or by any other means. It exists as a type contract
 *   for dependency injection and testing.
 *
 * ─── Quick start (Gateway mode) ───────────────────────────────────────────
 *
 * ```ts
 * import { GatewayMemoryClient } from "./src/adapters/gateway-client/index.js";
 *
 * const client = new GatewayMemoryClient({
 *   baseUrl: "http://127.0.0.1:8420",
 * });
 * const recall = await client.recall({ query: "hello", session_key: "s-1" });
 * ```
 *
 * ─── Legacy MemoryPlugin mode ─────────────────────────────────────────────
 *
 * ```ts
 * import { MemoryPlugin } from "./src/sdk/plugin.js";
 * const plugin = new MemoryPlugin({ gatewayUrl: "http://127.0.0.1:8420" });
 * await plugin.initialize();
 * const result = await plugin.recall("hello", "s-1");
 * ```
 *
 * @see GatewayMemoryClient — the primary HTTP client for Gateway access
 * @see MemoryPlugin — high-level SDK class wrapping GatewayMemoryClient
 * @see ToolRegistration — tool descriptor passed to registerTool()
 * @see PromptContext — context passed to the beforePrompt handler
 * @see TurnContext — context passed to the afterTurn handler
 */

import type { Logger } from "../core/types.js";
import type {
  PlatformKind,
  ToolRegistration,
  ResolvedLLMConfig,
  PromptContext,
  TurnContext,
} from "./types.js";

/**
 * Every lifecycle event the SDK hooks into.
 *
 * In Gateway mode, lifecycle events are handled by the Gateway process.
 * This type is retained for backward compatibility.
 */
export type SdkLifecycleEvent =
  /** Fires before the LLM processes a user message (for recall injection). */
  | "beforePrompt"
  /** Fires after the LLM completes a turn (for conversation capture). */
  | "afterTurn"
  /** Fires when the host shuts down (for clean resource release). */
  | "shutdown";

/**
 * Canonical logger level union.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

// ============================
// MemoryPlatformAdapter
// ============================

/**
 * Abstract adapter interface for host platform integration.
 *
 * @deprecated The recommended integration path is through the Gateway HTTP API
 *   via `GatewayMemoryClient` (see `src/adapters/gateway-client/index.ts`).
 *   This interface is retained for backward compatibility and for scenarios
 *   where direct MemoryPlugin integration is preferred.
 *
 * New platforms should use `GatewayMemoryClient` directly or wrap it with
 * `createGatewayPlatformAdapter()` for lifecycle management.
 */
export interface MemoryPlatformAdapter {
  /** Platform identifier (e.g. "codex", "claude-code", "dify"). */
  readonly platform: PlatformKind;

  /** Logger provided by the platform. */
  readonly logger: Logger;

  /**
   * Load raw configuration from platform-specific sources.
   *
   * In Gateway mode, configuration is managed by the Gateway process.
   * This method may return an empty object.
   */
  loadConfig(): Record<string, unknown>;

  /**
   * Resolve the base directory for memory data storage.
   *
   * In Gateway mode, data storage is managed by the Gateway process.
   * This method may return a temporary directory or the platform's
   * preferred data location.
   */
  resolveDataDir(): string;

  /**
   * Optional standalone LLM for memory extraction.
   *
   * In Gateway mode, LLM configuration is managed by the Gateway process.
   * Return `null` (the common case) to let the Gateway handle LLM calls.
   */
  resolveStandaloneLLM(): ResolvedLLMConfig | null;

  /**
   * Register a tool with the platform so its LLM can invoke it.
   *
   * In Gateway mode, tools are exposed through the MCP server or
   * Gateway's own tool endpoints. This method may be a no-op.
   */
  registerTool(spec: ToolRegistration): void;

  /**
   * Subscribe to a platform lifecycle event.
   *
   * In Gateway mode, lifecycle events flow through the Gateway HTTP API.
   * This method may be a no-op if the platform handles lifecycle via
   * direct GatewayMemoryClient calls.
   */
  on(event: "beforePrompt" | "afterTurn" | "shutdown", handler: (...args: any[]) => Promise<void>): void;
}
