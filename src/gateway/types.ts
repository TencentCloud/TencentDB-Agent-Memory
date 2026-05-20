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
// /
// ============================

export interface RootResponse {
  service: "TencentDB Agent Memory Gateway";
  kind: "api";
  version: string;
  message: string;
  endpoints: {
    method: "GET" | "POST";
    path: string;
    description: string;
  }[];
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
  context: string;
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
  /** Epoch ms when the captured turn began. Hosts that reconstruct turns out-of-process should set this. */
  started_at?: number;
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
  /** Optional session-key prefixes for host/project scoped search. */
  session_key_prefixes?: string[];
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
  /** Optional session-key prefixes for host/project scoped search. */
  session_key_prefixes?: string[];
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
  /** Wait for L1 extraction to drain before returning (default: true). */
  wait_for_l1?: boolean;
  /** Bounded L1 extraction concurrency for this seed run. */
  l1_concurrency?: number;
  /** Coalesce pending L2 records into batches during final full-pipeline flush. */
  l2_batch_size?: number;
  /** Wait for final L1→L2→L3 processing before returning (default: false). */
  wait_for_full_pipeline?: boolean;
  /** Max wait time for final L1→L2→L3 processing. */
  full_pipeline_timeout_ms?: number;
  /**
   * Write seed output into the currently running memory store instead of an
   * isolated timestamped seed directory. Intended for trusted local importers.
   */
  import_into_current_store?: boolean;
  /** Plugin config overrides (deep-merged on top of gateway memory config). */
  config_override?: Record<string, unknown>;
}

export interface SeedResponse {
  sessions_processed: number;
  rounds_processed: number;
  messages_processed: number;
  l0_recorded: number;
  full_pipeline_flushed?: boolean;
  duration_ms: number;
  output_dir: string;
}
