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
}

// ============================
// /status
// ============================

export interface StatusResponse {
  stores: {
    vectorStore: boolean;
    embeddingService: boolean;
  };
  scheduler: {
    enabled: boolean;
    started: boolean;
    destroyed: boolean;
    queues: {
      l1: number;
      l2: number;
      l3: number;
      l1Pending: boolean;
      l2Pending: boolean;
      l3Pending: boolean;
      l1Idle: boolean;
      l2Idle: boolean;
      l3Idle: boolean;
    };
  };
  sessions: Array<{
    sessionKey: string;
    known: boolean;
    state?: {
      conversation_count: number;
      last_extraction_time: string;
      last_extraction_updated_time: string;
      last_active_time: number;
      l2_pending_l1_count: number;
      warmup_threshold: number;
      l2_last_extraction_time: string;
    };
    effectiveL1Threshold?: number;
    bufferedMessageCount: number;
    timers: {
      l1IdlePending: boolean;
      l1IdleScheduledTime: number;
      l2SchedulePending: boolean;
      l2ScheduleScheduledTime: number;
      l1Queued: boolean;
      l2Queued: boolean;
      l1RetryCount: number;
    };
    queues: StatusResponse["scheduler"]["queues"];
  }>;
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
