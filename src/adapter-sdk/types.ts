/**
 * Adapter SDK — Unified type contracts for cross-platform memory adapters.
 *
 * Two contracts, one boundary each:
 *
 *   1. `MemoryClient` — THE one client interface a platform adapter consumes.
 *      It hides *where* the memory engine runs: `InProcessMemoryClient` wraps
 *      `TdaiCore` directly (same Node process), `HttpMemoryClient` talks to a
 *      remote `TdaiGateway` over REST. Adapters never see the difference.
 *
 *   2. `PlatformAdapter` — THE one interface a new platform must implement
 *      (usually by extending `BasePlatformAdapter`). A "platform" here is
 *      anything that hosts an agent and wants memory: Claude Code (MCP),
 *      Dify (External Knowledge API), a CLI, a web service, …
 *
 * Design notes:
 * - All params/results are camelCase. snake_case appears ONLY on the HTTP
 *   wire (see transports/http.ts) so the SDK surface matches the rest of the
 *   TypeScript codebase while staying byte-compatible with the Gateway API
 *   consumed by the Hermes Python provider.
 * - Result shapes are transport-invariant: both transports return the same
 *   fields with the same semantics, verified by mirrored unit tests.
 */

import type { MemorySearchResultItem } from "../core/tools/memory-search.js";
import type { ConversationSearchResultItem } from "../core/tools/conversation-search.js";
import type {
  RecallResult,
  CaptureResult,
  CompletedTurn,
  MemorySearchParams,
  ConversationSearchParams,
} from "../core/types.js";
import type { MemorySearchResult } from "../core/tools/memory-search.js";
import type { ConversationSearchResult } from "../core/tools/conversation-search.js";

// ============================
// MemoryClient — params & outcomes
// ============================

/** Parameters for a recall (memory prefetch before an LLM turn). */
export interface RecallParams {
  /** The user's current message / query text. */
  query: string;
  /** Stable session identifier (groups L0 records, scopes pipeline state). */
  sessionKey: string;
  /**
   * Optional user identifier. Reserved: forwarded on the HTTP wire but
   * currently ignored by the engine (single-user).
   */
  userId?: string;
}

/** Outcome of a recall operation. */
export interface RecallOutcome {
  /**
   * Stable recall context intended for the system prompt (persona, scene
   * navigation, tool guidance). Mirrors `RecallResult.appendSystemContext`
   * and the Gateway's `context` field. Empty string when nothing recalled.
   */
  context: string;
  /** Per-turn dynamic context intended to precede the user message (L1 hits). */
  prependContext?: string;
  /** Search strategy the engine used (e.g. "hybrid", "embedding", "fts"). */
  strategy?: string;
  /** Number of L1 memories recalled. */
  memoryCount: number;
}

/** Parameters for capturing one completed conversation turn. */
export interface CaptureParams {
  /** The user's message text for this turn. */
  userContent: string;
  /** The assistant's response text for this turn. */
  assistantContent: string;
  /** Stable session identifier. */
  sessionKey: string;
  /** Optional sub-session identifier. */
  sessionId?: string;
  /** Optional user identifier (reserved — currently ignored by the engine). */
  userId?: string;
  /**
   * Optional full message list for the turn (tool calls etc.). When omitted,
   * the transport synthesizes `[{role:"user"},{role:"assistant"}]` — the same
   * default the Gateway applies for the Hermes provider.
   */
  messages?: unknown[];
}

/** Outcome of a capture operation. */
export interface CaptureOutcome {
  /** Number of L0 messages recorded. */
  l0Recorded: number;
  /** Whether the L1/L2/L3 pipeline scheduler was notified. */
  schedulerNotified: boolean;
}

/** Parameters for searching L1 structured memories. */
export interface SearchMemoriesParams {
  query: string;
  /** Max results (engine default 5, hard cap 20). */
  limit?: number;
  /** Filter by memory type: "persona" | "episodic" | "instruction". */
  type?: "persona" | "episodic" | "instruction" | string;
  /** Filter by scene name (substring match). */
  scene?: string;
}

/** Outcome of an L1 memory search. */
export interface SearchMemoriesOutcome {
  /** Human/LLM-readable formatted result text. */
  text: string;
  total: number;
  strategy: string;
  /**
   * Structured per-record results (id, score, timestamps). May be empty when
   * the backing gateway predates the `include_items` protocol extension.
   */
  items: MemorySearchResultItem[];
}

/** Parameters for searching L0 raw conversation records. */
export interface SearchConversationsParams {
  query: string;
  limit?: number;
  /** Restrict results to one session. */
  sessionKey?: string;
}

/** Outcome of an L0 conversation search. */
export interface SearchConversationsOutcome {
  text: string;
  total: number;
  /** Structured per-message results — same caveat as {@link SearchMemoriesOutcome.items}. */
  items: ConversationSearchResultItem[];
}

/** Outcome of a health probe. */
export interface HealthOutcome {
  status: "ok" | "degraded";
  vectorStore: boolean;
  embeddingService: boolean;
  version?: string;
}

/**
 * THE one client interface every platform adapter consumes.
 *
 * Obtain an instance via `createMemoryClient()` (factory.ts). All methods
 * reject with `MemoryClientError` on transport/engine failure — adapters that
 * must never break their host should route calls through
 * `BasePlatformAdapter.safeRecall` / `safeCapture`.
 */
export interface MemoryClient {
  /** Retrieve relevant memory context for an upcoming LLM turn. */
  recall(params: RecallParams): Promise<RecallOutcome>;
  /** Persist a completed conversation turn (L0) and trigger the pipeline. */
  capture(params: CaptureParams): Promise<CaptureOutcome>;
  /** Search L1 structured memories (facts, preferences, instructions). */
  searchMemories(params: SearchMemoriesParams): Promise<SearchMemoriesOutcome>;
  /** Search L0 raw conversation history. */
  searchConversations(params: SearchConversationsParams): Promise<SearchConversationsOutcome>;
  /** Flush buffered pipeline work for one session (NOT a global shutdown). */
  endSession(sessionKey: string): Promise<void>;
  /** Probe engine/gateway health. */
  health(): Promise<HealthOutcome>;
  /** Release resources owned by this client (idempotent). */
  close(): Promise<void>;
}

// ============================
// PlatformAdapter — the one interface a new platform implements
// ============================

/**
 * THE one interface a new platform must implement.
 *
 * Prefer extending `BasePlatformAdapter`, which wires a `MemoryClient`,
 * a tagged logger, and resilience helpers; then only `platformName` and
 * `start()` remain to be written.
 */
export interface PlatformAdapter {
  /** Stable identifier, e.g. "claude-code", "dify". */
  readonly platformName: string;
  /** Start serving the platform (bind server / begin reading stdio / …). */
  start(): Promise<void>;
  /** Stop serving and release resources (must be idempotent). */
  stop(): Promise<void>;
}

// ============================
// TdaiCoreLike — structural core subset for DI / tests
// ============================

/**
 * Structural subset of `TdaiCore` used by `InProcessMemoryClient`.
 *
 * Exists so unit tests (and embedding hosts that already own a core) can
 * inject a lightweight fake without dragging sqlite-vec/embedding/LLM
 * dependencies into the test process. `TdaiCore` satisfies this interface
 * structurally — no cast needed.
 */
export interface TdaiCoreLike {
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  handleBeforeRecall(userText: string, sessionKey: string): Promise<RecallResult>;
  handleTurnCommitted(turn: CompletedTurn): Promise<CaptureResult>;
  searchMemories(params: MemorySearchParams): Promise<{ text: string; total: number; strategy: string }>;
  searchConversations(params: ConversationSearchParams): Promise<{ text: string; total: number }>;
  /** Optional structured variants (present on current TdaiCore). */
  searchMemoriesStructured?(params: MemorySearchParams): Promise<MemorySearchResult>;
  searchConversationsStructured?(params: ConversationSearchParams): Promise<ConversationSearchResult>;
  handleSessionEnd(sessionKey: string): Promise<void>;
  getVectorStore(): unknown;
  getEmbeddingService(): unknown;
}
