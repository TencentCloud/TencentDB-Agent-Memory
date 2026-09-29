export type CaptureMode = "summary" | "turn" | "raw";

export interface AdapterLogger {
  debug?(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface CodexAdapterConfig {
  gatewayUrl: string;
  gatewayCommand?: string;
  gatewayApiKey?: string;
  requestTimeoutMs: number;
  enableSupervisor: boolean;
  explicitSessionKey?: string;
  userId: string;
  logDir: string;
  captureMode: CaptureMode;
  resultMaxChars: number;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  uptime: number;
  stores: { vectorStore: boolean; embeddingService: boolean };
}

export interface RecallRequest { query: string; session_key: string; user_id?: string }
export interface RecallResponse { context: string; strategy?: string; memory_count?: number }
export interface CaptureRequest {
  user_content: string;
  assistant_content: string;
  session_key: string;
  session_id?: string;
  user_id?: string;
  messages?: unknown[];
}
export interface CaptureResponse { l0_recorded: number; scheduler_notified: boolean }
export interface MemorySearchRequest { query: string; limit?: number; type?: string; scene?: string }
export interface MemorySearchResponse { results: string; total: number; strategy: string }
export interface ConversationSearchRequest { query: string; limit?: number; session_key?: string }
export interface ConversationSearchResponse { results: string; total: number }
export interface SessionEndRequest { session_key: string; user_id?: string }
export interface SessionEndResponse { flushed: boolean }
export interface SeedRequest {
  data: unknown;
  session_key?: string;
  strict_round_role?: boolean;
  auto_fill_timestamps?: boolean;
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

export type { CallToolResult as McpTextResult } from "@modelcontextprotocol/sdk/types.js";
