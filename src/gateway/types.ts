/**
 * TDAI Gateway — Request/Response types for the HTTP API.
 */

import type { MemorySearchResultItem } from "../core/tools/memory-search.js";
import type { ConversationSearchResultItem } from "../core/tools/conversation-search.js";

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
  /**
   * Per-turn dynamic context intended to precede the user message
   * (`RecallResult.prependContext`). Additive field introduced with the
   * Adapter SDK so HTTP clients receive the same recall surface as
   * in-process hosts; existing clients (Hermes `client.py` reads only
   * `context`) ignore it.
   */
  prepend_context?: string;
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
   * Opt-in: when `true`, the response additionally carries structured
   * `items` (per-record id/score/timestamps). Defaults to `false` so
   * existing clients (Hermes `client.py`) keep the legacy text-only shape.
   */
  include_items?: boolean;
}

export interface MemorySearchResponse {
  results: string;
  total: number;
  strategy: string;
  /** Present only when the request set `include_items: true`. */
  items?: MemorySearchResultItem[];
}

// ============================
// /search/conversations
// ============================

export interface ConversationSearchRequest {
  query: string;
  limit?: number;
  session_key?: string;
  /** Opt-in structured items — see {@link MemorySearchRequest.include_items}. */
  include_items?: boolean;
}

export interface ConversationSearchResponse {
  results: string;
  total: number;
  /** Present only when the request set `include_items: true`. */
  items?: ConversationSearchResultItem[];
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
