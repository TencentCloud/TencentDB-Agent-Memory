/**
 * TDAI Gateway — Request/Response types for the HTTP API.
 */

// ============================
// Common
// ============================

export interface GatewayErrorResponse {
  error: string;
  code?: string;
}

// ============================
// /health
// ============================

export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  uptime: number;
  stores: {
    vectorStore: boolean;
    embeddingService: boolean;
  };
  /** Whether the Gateway is routing per-account (structural multi-tenant). */
  multi_tenant?: boolean;
  /**
   * Multi-tenant only: number of per-account cores currently resident in
   * memory. Omitted in single-tenant mode (there is exactly one shared core).
   */
  active_cores?: number;
  /**
   * Multi-tenant only: live state of the shared background-extraction limiter
   * that caps concurrent L1/L2/L3 runs across all cores (design §8.4 #5).
   * `limit` is the configured cap (0 = unbounded), `active` the permits in use,
   * `waiting` the runs currently blocked on a permit.
   */
  extraction?: { limit: number; active: number; waiting: number };
  /**
   * Multi-tenant only: resident-core LRU state. `count` is how many per-account
   * cores are warm right now, `limit` the configured cap (0 = unlimited), and
   * `pinned` how many are currently serving a request (held by a lease). A
   * `count` above `limit` with a matching `pinned` means the cap is being held
   * past its bound because every candidate core is busy — transient and safe.
   */
  resident?: { count: number; limit: number; pinned: number };
  /**
   * Embedding **configuration intent** — answers "is vector recall supposed to
   * be on?" without a network probe (health must stay a cheap liveness check).
   *
   * `configured` is `true` only when embedding is enabled, the provider is not
   * the `"none"` disable sentinel, and the config carries no error. It does NOT
   * confirm the embedding endpoint is reachable — for the live runtime signal,
   * read the `strategy` field returned by `POST /search/memories` (`hybrid` /
   * `embedding` mean vectors actually fired). In multi-tenant mode this is the
   * embedding signal health can give, since cores (and their embedding services)
   * are lazy and per-account — `stores.embeddingService` stays `false` there.
   */
  embedding?: {
    configured: boolean;
    provider: string;
    model?: string;
    dimensions?: number;
    /** Configured recall strategy: "hybrid" | "embedding" | "keyword". */
    recallStrategy: string;
  };
}

// ============================
// /recall
// ============================

export interface RecallRequest {
  query: string;
  session_key: string;
  user_id?: string;
}

export interface RecallResponse {
  /**
   * Stable recall context for the system prompt end (persona, scene nav,
   * tools guide). Mirrors `RecallResult.appendSystemContext`.
   */
  context: string;
  /**
   * Query-time L1 relevant memories, meant to be prepended to the user prompt
   * (dynamic, per-turn). Mirrors `RecallResult.prependContext`. Empty string
   * when no L1 memories were recalled this turn.
   *
   * Without this, callers get persona/scene but never the query-relevant
   * memories, while `memory_count` still reports L1 hits — see design §5.3/§8.4#6.
   */
  prepend_context: string;
  strategy?: string;
  memory_count?: number;
}

// ============================
// /capture
// ============================

export interface CaptureRequest {
  user_content: string;
  assistant_content: string;
  session_key: string;
  session_id?: string;
  user_id?: string;
  messages?: unknown[];
}

export interface CaptureResponse {
  l0_recorded: number;
  scheduler_notified: boolean;
}

// ============================
// /search/memories
// ============================

export interface MemorySearchRequest {
  query: string;
  limit?: number;
  type?: string;
  scene?: string;
  /**
   * Account/session to scope the search to. **Required in multi-tenant mode**
   * (the Gateway returns 400 without it); ignored in single-tenant mode. In
   * the structural multi-tenant route this routes to the account's own core, so
   * L1 isolation is physical — see design §8.4 #3.
   */
  session_key?: string;
}

export interface MemorySearchResponse {
  results: string;
  total: number;
  strategy: string;
}

// ============================
// /search/conversations
// ============================

export interface ConversationSearchRequest {
  query: string;
  limit?: number;
  session_key?: string;
}

export interface ConversationSearchResponse {
  results: string;
  total: number;
}

// ============================
// /session/end
// ============================

export interface SessionEndRequest {
  session_key: string;
  user_id?: string;
}

export interface SessionEndResponse {
  flushed: boolean;
}

// ============================
// /namespace/wipe
// ============================

/**
 * Request body for `POST /namespace/wipe` — account hard-delete.
 *
 * Multi-tenant only. Removes the account's core and its entire on-disk
 * dataDir (L0/L1/L2/L3). Backs the host's `unbind_and_wipe_account()`.
 */
export interface WipeRequest {
  session_key: string;
}

export interface WipeResponse {
  wiped: boolean;
}

// ============================
// /seed
// ============================

/**
 * Request body for `POST /seed`.
 *
 * Accepts the same input formats as the CLI `seed` command:
 * - Format A: `{ sessions: [{ sessionKey, conversations: [[...msgs]] }] }`
 * - Format B: `[{ sessionKey, conversations: [[...msgs]] }]`
 *
 * Wrapped in an envelope with optional control fields.
 */
export interface SeedRequest {
  /**
   * Seed input data — either Format A object or Format B array.
   * This is the same structure accepted by `openclaw memory-tdai seed --input`.
   */
  data: unknown;
  /** Fallback session key when input sessions lack one. */
  session_key?: string;
  /** Require each round to have both user and assistant messages. */
  strict_round_role?: boolean;
  /** Auto-fill missing timestamps (default: true). */
  auto_fill_timestamps?: boolean;
  /** Plugin config overrides (deep-merged on top of gateway memory config). */
  config_override?: Record<string, unknown>;
}

export interface SeedResponse {
  sessions_processed: number;
  rounds_processed: number;
  messages_processed: number;
  l0_recorded: number;
  duration_ms: number;
  output_dir: string;
}
