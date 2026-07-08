/**
 * PlatformAdapter SDK — type definitions.
 *
 * The SDK contract: a new agent platform implements *one* interface
 * (IPlatformAdapter) with *one* method (registerHandlers). The SDK
 * runtime handles everything else:
 *
 *   - TdaiCore bootstrap + initialize + destroy
 *   - Tool schema → Core method routing
 *   - Lifecycle event → Core method mapping
 *   - Error degradation (graceful fallback, logging)
 *
 * The caller provides a HostAdapter — the SDK does not construct one.
 * This keeps the SDK decoupled from any specific host adapter impl.
 */

import type { MemoryTdaiConfig } from "../../config.js";
import type { TdaiCore } from "../../core/tdai-core.js";
import type { HostAdapter, Logger } from "../../core/types.js";

// ── Core abstraction ───────────────────────────────────────────────────

/**
 * The ONE interface a new platform adapter must implement.
 *
 * For 90% of platforms, registerHandlers is under 50 lines: a flat list
 * of ctx.registerTool(...) calls plus 2-3 ctx.onLifecycle(...) calls.
 */
export interface IPlatformAdapter {
  readonly platformId: string;
  registerHandlers(ctx: IPlatformAdapterContext): Promise<void> | void;
}

// ── Context ────────────────────────────────────────────────────────────

export interface IPlatformAdapterContext {
  readonly core: TdaiCore;
  readonly logger: Logger;
  readonly config: MemoryTdaiConfig;

  /** Register a tool. routeTo="memory_search"/"conversation_search" = zero code. */
  registerTool(def: PlatformToolDefinition): void;

  /** Wire a lifecycle callback. Omit handler to use the SDK default. */
  onLifecycle(event: PlatformLifecycleEvent, handler?: PlatformLifecycleHandler): void;
}

// ── Tool definition ────────────────────────────────────────────────────

export type ToolRouteTarget = "memory_search" | "conversation_search" | "custom";

export interface PlatformToolDefinition {
  name: string;
  description: string;
  extraParameters?: Record<string, unknown>;
  routeTo: ToolRouteTarget;
  customHandler?: (params: Record<string, unknown>) => Promise<string>;
}

// ── Lifecycle ───────────────────────────────────────────────────────────

export type PlatformLifecycleEvent =
  | "before_prompt"
  | "after_turn"
  | "session_end"
  | "shutdown";

export type PlatformLifecycleHandler = (
  payload: unknown,
  ctx: IPlatformAdapterContext,
) => Promise<void> | void;

// ── Bootstrap ──────────────────────────────────────────────────────────

export interface PlatformAdapterBootstrapOptions {
  adapter: IPlatformAdapter;
  /** Caller-provided HostAdapter — SDK does NOT construct one. */
  hostAdapter: HostAdapter;
  dataDir: string;
  config: MemoryTdaiConfig;
  debug?: boolean;
}

/** Tool schema object returned for host-side tool registration. */
export interface PlatformToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Tool execution result returned to the host. */
export interface PlatformToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface PlatformAdapterBootstrapResult {
  core: TdaiCore;
  /** Tool schemas ready for host-side registration (MCP tools/list, etc.). */
  toolSchemas: PlatformToolSchema[];
  /** Dispatch a tool call by name. Host's tools/call handler calls this. */
  executeTool: (name: string, params: Record<string, unknown>) => Promise<PlatformToolResult>;
  /** Lifecycle callbacks keyed by event. Host calls each for its events. */
  lifecycleCallbacks: ReadonlyMap<PlatformLifecycleEvent, readonly PlatformLifecycleHandler[]>;
  /** Bounded shutdown (drains bgTasks, closes stores). Call on process exit. */
  shutdown: () => Promise<void>;
}
