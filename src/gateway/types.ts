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

/**
 * Diagnostic snapshot. Same auth posture as /health (unauth, loopback-only).
 * Adds: traffic counters, totals, lastRecall (with truncated query +
 * queryHash for safe monitoring), lastCapture, lastError (with category
 * and ≤120-char message).
 *
 * `status` reflects vectorStore+embeddingService only; `totals.stale` is
 * independent — a DB-read failure does NOT flip a healthy service to
 * "degraded".
 */
export interface StatusResponse {
  status: "ok" | "degraded";
  version: string;
  uptimeSec: number;
  startedAt: string;
  dataPath: string;
  vectorStore: boolean;
  embeddingService: boolean;
  totals: {
    l0Messages: number;
    l1Records: number;
    sceneBlocks: number;
    stale: boolean;
  };
  counters: {
    recalls: number;
    captures: number;
    sessionEnds: number;
    searchMemories: number;
    searchConversations: number;
    seeds: number;
    errors: number;
  };
  lastRecall: {
    at: string;
    query: string;
    queryHash: string;
    sessionKey: string;
    latencyMs: number;
    count: number;
  } | null;
  lastCapture: {
    at: string;
    sessionKey: string;
    latencyMs: number;
    status: "ok" | "failed";
  } | null;
  lastError: {
    at: string;
    source: string;
    category: "validation" | "store" | "embedding" | "internal" | "other";
    message: string;
  } | null;
  /** Consolidation snapshot (P6/P7) — merged in from the second /status
   * handler that used to shadow this one. */
  consolidation: {
    enabled: boolean;
    checkpoint: string;
    inFlight: boolean;
    lastRun: unknown;
  };
  roles: unknown;
  reindexInProgress: boolean;
  /** Last runs from the control plane (tz-09 Ф1) — empty when the control
   * plane is unavailable; /status never fails over it. */
  runs: Array<{
    runId: string;
    role: string;
    state: string;
    fence: number;
    startedAt: string;
    errorClass: string | null;
  }>;
}

// ============================
// /recall
// ============================

export interface RecallRequest {
  query: string;
  session_key: string;
  user_id?: string;
  /** Project this turn happened in (git-root of cwd). Optional: absent → no scope filtering. */
  project_id?: string;
  /**
   * Inject the L3 persona in this response. Optional: absent → true (legacy behaviour).
   * Clients that inject recall context every turn should send `false` on most turns —
   * the persona is tens of KB and changes rarely.
   */
  include_persona?: boolean;
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
  /** Project this turn happened in (git-root of cwd). Optional: absent → memory stays global. */
  project_id?: string;
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

// ============================
// /memory/* (wave tdai-memory-subagents-2026-08-02)
// ============================

/**
 * Discovery response for the pi extension (auth-free loopback).
 * Contains the token file PATH — never the token itself (INVARIANT nogo-secrets).
 */
export interface MemoryInfoResponse {
  /** Resolved gateway data dir (~/.pi/agent-memory/tdai). */
  dataDir: string;
  /** Absolute path of the loopback token file (sibling of dataDir). */
  tokenPath: string;
  /** Gateway version string. */
  version: string;
}

/** One L1 record row as returned by /memory/records. */
export interface MemoryRecordRow {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  session_key: string;
  session_id: string;
  timestamp_str: string;
  created_time: string;
  updated_time: string;
  metadata_json: string;
  project_id: string;
  scope: string;
}

export interface MemoryRecordsResponse {
  total: number;
  records: MemoryRecordRow[];
}

/** One scene/persona file entry as returned by /memory/blocks. */
export interface MemoryBlockInfo {
  /** Path relative to dataDir (e.g. "scene_blocks/<slug>/<file>.md"). */
  path: string;
  kind: "scene" | "persona";
  filename: string;
  /** Character count (the memory-keeper limits are char-based). */
  size: number;
  /** Char limit for this kind: scene 1500, persona 2000. */
  limit: number;
  over: boolean;
  /** Scene project slug (only for kind === "scene"). */
  project?: string;
}

export interface MemoryBlocksResponse {
  limits: { scene: number; persona: number };
  blocks: MemoryBlockInfo[];
}

/** One similar-record hit inside a duplicate cluster. */
export interface MemoryDuplicateHit {
  record_id: string;
  /** Cosine similarity score (0..1, rounded to 4 dp). */
  score: number;
  scope: string;
  project_id: string;
  type: string;
}

export interface MemoryDuplicateCluster {
  record_id: string;
  similar: MemoryDuplicateHit[];
}

/** Response of /memory/duplicates (vector candidate-finding only, no LLM). */
export interface MemoryDuplicatesResponse {
  total: number;
  clusters: MemoryDuplicateCluster[];
  topK: number;
  threshold: number;
  /** True when vector store / embedding service is unavailable (fail-open). */
  degraded: boolean;
  reason?: string;
}

/** Integrity report of /memory/validate. */
export interface MemoryValidateResponse {
  dataDir: string;
  checks: {
    /** Char sizes vs per-kind limits; overLimit lists the violations. */
    sizes: {
      checked: number;
      overLimit: MemoryBlockInfo[];
    };
    /** JSON parse check on records/*.jsonl lines and scene_index/*.json. */
    json: {
      checkedFiles: number;
      malformed: Array<{ file: string; line: number }>;
      valid: boolean;
    };
    /** META frontmatter presence on scene blocks. */
    meta: {
      checked: number;
      missingMeta: string[];
      valid: boolean;
    };
    /** vec-vs-meta count consistency (null = vec0 table absent / DB error). */
    vecMeta: {
      metaCount: number | null;
      vecCount: number | null;
      consistent: boolean | null;
      note?: string;
    };
  };
}
