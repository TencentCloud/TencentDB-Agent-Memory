/**
 * MemoryAdapter — the transport-agnostic capability contract of the SDK.
 *
 * This is the single interface the "unified adapter SDK" is built around.
 * It captures *what* TDAI memory can do (recall, search, capture, flush)
 * without saying *how* the bytes travel. Two axes plug into it:
 *
 *   1. Transport (how to reach the engine): `GatewayMemoryAdapter` speaks
 *      HTTP to the Gateway. A future `EmbeddedMemoryAdapter` could call
 *      `TdaiCore` in-process — same interface, no platform code changes.
 *
 *   2. Platform (which agent host consumes memory): MCP, Dify, LangChain,
 *      etc. consume a `MemoryAdapter` (usually via {@link buildMemoryTools})
 *      and translate its capabilities into their own tool/hook surface.
 *
 * Every field is normalized to a clean camelCase shape so platform adapters
 * never touch the snake_case HTTP wire format.
 */

import { TdaiGatewayClient } from "./gateway-client.js";
import type { TdaiGatewayClientOptions } from "./gateway-client.js";

// ============================
// Normalized I/O shapes
// ============================

export interface RecallInput {
  query: string;
  sessionKey: string;
  userId?: string;
}

export interface RecallResult {
  /** Recall context to inject into the prompt (may be empty). */
  context: string;
  /** Retrieval strategy the engine used (e.g. "hybrid", "vector"). */
  strategy?: string;
  /** Number of L1 memories that contributed to the context. */
  memoryCount: number;
}

export interface MemorySearchInput {
  query: string;
  limit?: number;
  /** Optional filter: persona | episodic | instruction. */
  type?: string;
  /** Optional scene-block filter. */
  scene?: string;
}

export interface MemorySearchResult {
  /** Human/LLM-readable, pre-formatted result text. */
  text: string;
  total: number;
  strategy: string;
}

export interface ConversationSearchInput {
  query: string;
  limit?: number;
  sessionKey?: string;
}

export interface ConversationSearchResult {
  text: string;
  total: number;
}

export interface CaptureInput {
  userContent: string;
  assistantContent: string;
  sessionKey: string;
  sessionId?: string;
  userId?: string;
  messages?: unknown[];
}

export interface CaptureResult {
  l0Recorded: number;
  schedulerNotified: boolean;
}

export interface MemoryHealth {
  /** True when the engine is reachable (status "ok" or "degraded"). */
  ok: boolean;
  /** Raw status string from the engine. */
  status: string;
  version?: string;
  /** True when reachable but running without a vector store. */
  degraded: boolean;
}

// ============================
// The contract
// ============================

/**
 * The one interface a new *transport* implements and every *platform*
 * adapter consumes. Keep it minimal: five verbs cover the full memory
 * read/write surface the issue asks for.
 */
export interface MemoryAdapter {
  /** Identifies where memory lives / how it is reached (for logs & health). */
  readonly platform: string;

  /** Liveness + readiness of the underlying engine. */
  health(): Promise<MemoryHealth>;

  /** Retrieve memory context for the current turn (read). */
  recall(input: RecallInput): Promise<RecallResult>;

  /** Search L1 structured memories (read). */
  searchMemories(input: MemorySearchInput): Promise<MemorySearchResult>;

  /** Search L0 raw conversation history (read). */
  searchConversations(input: ConversationSearchInput): Promise<ConversationSearchResult>;

  /** Persist a completed conversation turn (write). */
  capture(input: CaptureInput): Promise<CaptureResult>;

  /** Flush a single session's buffered pipeline work (write, best-effort). */
  endSession(sessionKey: string): Promise<void>;
}

// ============================
// Gateway-backed implementation (HTTP transport)
// ============================

export interface GatewayMemoryAdapterOptions extends TdaiGatewayClientOptions {
  /** Override the reported platform label (default: "gateway"). */
  platform?: string;
  /** Provide a pre-built client instead of constructing one from options. */
  client?: TdaiGatewayClient;
}

/**
 * `MemoryAdapter` over the Gateway HTTP API — the reference transport.
 *
 * This is intentionally thin: all resilience (timeouts, retries, auth,
 * typed errors) lives in {@link TdaiGatewayClient}, so this class only
 * maps wire responses onto the normalized shapes above.
 */
export class GatewayMemoryAdapter implements MemoryAdapter {
  readonly platform: string;
  private readonly client: TdaiGatewayClient;

  constructor(opts: GatewayMemoryAdapterOptions = {}) {
    this.platform = opts.platform ?? "gateway";
    this.client = opts.client ?? new TdaiGatewayClient(opts);
  }

  /** Convenience: build from environment variables. */
  static fromEnv(overrides: GatewayMemoryAdapterOptions = {}): GatewayMemoryAdapter {
    return new GatewayMemoryAdapter({
      client: TdaiGatewayClient.fromEnv(overrides),
      platform: overrides.platform,
    });
  }

  async health(): Promise<MemoryHealth> {
    const res = await this.client.health();
    return {
      ok: res.status === "ok" || res.status === "degraded",
      status: res.status,
      version: res.version,
      degraded: res.status === "degraded",
    };
  }

  async recall(input: RecallInput): Promise<RecallResult> {
    const res = await this.client.recall(input.query, input.sessionKey, input.userId);
    return {
      context: res.context ?? "",
      strategy: res.strategy,
      memoryCount: res.memory_count ?? 0,
    };
  }

  async searchMemories(input: MemorySearchInput): Promise<MemorySearchResult> {
    const res = await this.client.searchMemories(input);
    return { text: res.results ?? "", total: res.total ?? 0, strategy: res.strategy ?? "" };
  }

  async searchConversations(input: ConversationSearchInput): Promise<ConversationSearchResult> {
    const res = await this.client.searchConversations(input);
    return { text: res.results ?? "", total: res.total ?? 0 };
  }

  async capture(input: CaptureInput): Promise<CaptureResult> {
    const res = await this.client.capture(input);
    return { l0Recorded: res.l0_recorded ?? 0, schedulerNotified: res.scheduler_notified ?? false };
  }

  async endSession(sessionKey: string): Promise<void> {
    if (!sessionKey) return;
    await this.client.endSession(sessionKey);
  }
}
