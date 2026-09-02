/**
 * TDAI Adapter SDK — the single interface a new Agent platform implements
 * (or consumes) to gain memory read/write access to the TDAI Core engine.
 *
 * Issue #3 (拓展): "封装统一的适配器 SDK，让新平台接入只需实现一个接口".
 *
 * Design
 * ------
 * `MemoryAdapter` is the host-neutral memory contract. It is intentionally a
 * strict subset of `TdaiCore`'s public surface — only the operations a
 * platform integration actually needs (recall / capture / search / session
 * end + lifecycle). Anything LLM- or storage-specific stays inside the core.
 *
 * Two ready-made implementations ship in this package:
 *
 *   - `HttpMemoryAdapter`        — talks to the HTTP Gateway (for Codex,
 *                                  Dify, or any platform that can do HTTP).
 *   - `InProcessMemoryAdapter`   — wraps a live `TdaiCore` instance in the
 *                                  same Node process (for embedded hosts /
 *                                  the MCP server).
 *
 * A new platform therefore has exactly *one* interface to target. It picks an
 * existing transport (HTTP or in-process) and is done; only platforms with a
 * bespoke transport need to implement `MemoryAdapter` themselves.
 *
 * Re-used core types (`RecallResult`, `CaptureResult`, `MemorySearchParams`,
 * `ConversationSearchParams`) are re-exported so adapters depend on this
 * module alone, not on `src/core` internals.
 */

// Re-export the core result/param shapes so adapter authors import only here.
export type {
  RecallResult,
  CaptureResult,
  MemorySearchParams,
  ConversationSearchParams,
} from "../../core/types.js";

import type {
  RecallResult,
  CaptureResult,
  MemorySearchParams,
  ConversationSearchParams,
} from "../../core/types.js";

/**
 * A conversation turn captured from a host platform.
 *
 * This is the platform-friendly analogue of core `CompletedTurn`: it keeps
 * only what every platform can supply (user text, assistant text, session
 * identity) plus the optional extras that improve capture quality. The core
 * `CompletedTurn` is reconstructed by the adapter at the boundary.
 */
export interface CaptureTurn {
  /** The user's original message text for this turn. */
  userText: string;
  /** The assistant's reply text for this turn. */
  assistantText: string;
  /** Stable session key (conversation channel). */
  sessionKey: string;
  /** Session id within the session key (optional). */
  sessionId?: string;
  /**
   * Full message history for the turn, if the platform exposes it.
   * When omitted, the adapter synthesises a 2-message [user, assistant] array.
   */
  messages?: unknown[];
  /** Epoch ms when the turn started (optional). */
  startedAt?: number;
}

/**
 * Outcome of a structured (L1) memory search.
 * Mirrors `TdaiCore.searchMemories()`'s return shape.
 */
export interface MemorySearchOutcome {
  /** Human-readable formatted result text (ready to hand back to an LLM). */
  text: string;
  /** Number of matching memories. */
  total: number;
  /** Search strategy used (e.g. "hybrid" / "embedding" / "fts"). */
  strategy: string;
}

/**
 * Outcome of a raw-conversation (L0) search.
 * Mirrors `TdaiCore.searchConversations()`'s return shape.
 */
export interface ConversationSearchOutcome {
  text: string;
  total: number;
}

/**
 * Health probe result.
 */
export interface HealthCheckResult {
  ok: boolean;
  /** Free-form detail (store availability, version, latency, …). */
  detail?: Record<string, unknown>;
}

/**
 * The single interface a platform adapter implements or consumes.
 *
 * Every method maps 1:1 to a `TdaiCore` capability, so an adapter is a thin
 * transport layer — it adds no memory logic of its own.
 */
export interface MemoryAdapter {
  /** Identifies the transport ("http" | "in-process" | custom). */
  readonly kind: string;

  /**
   * Prepare the adapter (open connections, warm caches, …).
   * Must be idempotent.
   */
  initialize(): Promise<void>;

  /** Release all resources. Safe to call once. */
  destroy(): Promise<void>;

  /**
   * Recall relevant memories for a user query, returning context to inject
   * into the upcoming LLM turn.
   *
   * Maps to: OpenClaw `before_prompt_build` / Hermes `prefetch()` /
   * `TdaiCore.handleBeforeRecall` / `POST /recall`.
   */
  recall(query: string, sessionKey: string): Promise<RecallResult>;

  /**
   * Capture a completed conversation turn and trigger the L0→L1→L2→L3
   * extraction pipeline.
   *
   * Maps to: OpenClaw `agent_end` / Hermes `sync_turn()` /
   * `TdaiCore.handleTurnCommitted` / `POST /capture`.
   */
  capture(turn: CaptureTurn): Promise<CaptureResult>;

  /**
   * Search structured L1 memories (persona / episodic / instruction).
   * Maps to: `TdaiCore.searchMemories` / `POST /search/memories`.
   */
  searchMemories(params: MemorySearchParams): Promise<MemorySearchOutcome>;

  /**
   * Search raw L0 conversation messages.
   * Maps to: `TdaiCore.searchConversations` / `POST /search/conversations`.
   */
  searchConversations(
    params: ConversationSearchParams,
  ): Promise<ConversationSearchOutcome>;

  /**
   * Flush a single session's buffered work (end of conversation).
   * Maps to: `TdaiCore.handleSessionEnd` / `POST /session/end`.
   */
  endSession(sessionKey: string): Promise<void>;

  /** Liveness probe (optional — defaults to ok). */
  healthCheck?(): Promise<HealthCheckResult>;
}

/**
 * Shared error type thrown by adapter implementations when the underlying
 * transport fails (non-2xx HTTP, closed core, …). Adapters wrap transport
 * errors in this so callers get a uniform catch surface.
 */
export class MemoryAdapterError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(message: string, opts?: { code?: string; status?: number; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "MemoryAdapterError";
    this.code = opts?.code ?? "ADAPTER_ERROR";
    this.status = opts?.status;
  }
}
