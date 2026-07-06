/**
 * Dify adapter — wire types for Dify's External Knowledge Base API and the
 * adapter's custom tool endpoints.
 *
 * Contract source: Dify docs, "External Knowledge API" (docs.dify.ai →
 * Knowledge Base → External Knowledge Base API). Dify acts as the CLIENT and
 * calls the endpoint we host:
 *
 *   POST <endpoint>/retrieval
 *   Authorization: Bearer <api key configured in the Dify console>
 *
 * Error semantics defined by that spec (returned with HTTP 403/404):
 *   1001 — invalid/malformed Authorization header format
 *   1002 — authorization failed (wrong key)
 *   2001 — the knowledge base does not exist
 */

// ============================
// POST /retrieval (Dify → adapter)
// ============================

export interface DifyRetrievalSetting {
  /** Maximum number of records to return. */
  top_k: number;
  /** Minimum relevance score threshold (0..1). */
  score_threshold: number;
}

/**
 * Metadata filter conditions (Dify sends these when the user configures
 * metadata filtering). The memory adapter does not index custom metadata, so
 * conditions are accepted but not applied.
 */
export interface DifyMetadataCondition {
  logical_operator?: "and" | "or";
  conditions?: Array<{
    name?: string[];
    comparison_operator?: string;
    value?: string;
  }>;
}

export interface DifyRetrievalRequest {
  /** Which external knowledge base to query — we route on this. */
  knowledge_id: string;
  /** The user's search query. */
  query: string;
  retrieval_setting?: DifyRetrievalSetting;
  metadata_condition?: DifyMetadataCondition;
}

/** One retrieved chunk in the shape Dify expects. */
export interface DifyRetrievalRecord {
  /** Text content of the retrieved chunk. */
  content: string;
  /** Relevance score, 0..1 preferred (we pass the engine's score through). */
  score: number;
  /** Document title shown in the Dify citation UI. */
  title: string;
  metadata?: Record<string, unknown>;
}

export interface DifyRetrievalResponse {
  records: DifyRetrievalRecord[];
}

/** Error body per the External Knowledge API spec. */
export interface DifyErrorBody {
  error_code: number;
  error_msg: string;
}

// ============================
// Knowledge id routing
// ============================

/** knowledge_id → L1 structured memory search. */
export const KNOWLEDGE_ID_MEMORIES = "tdai-memories";
/** knowledge_id → L0 raw conversation search. */
export const KNOWLEDGE_ID_CONVERSATIONS = "tdai-conversations";

// ============================
// /tools/* (Dify Custom Tool → adapter)
// ============================

export interface DifyCaptureToolRequest {
  user_content: string;
  assistant_content: string;
  session_key?: string;
  session_id?: string;
}

export interface DifyCaptureToolResponse {
  l0_recorded: number;
  scheduler_notified: boolean;
}

export interface DifyRecallToolRequest {
  query: string;
  session_key?: string;
}

export interface DifyRecallToolResponse {
  context: string;
  strategy?: string;
  memory_count: number;
}
