export interface AdapterLogger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface OpenCodeAdapterConfig {
  gatewayUrl: string;
  gatewayCommand?: string;
  gatewayApiKey?: string;
  requestTimeoutMs: number;
  startupTimeoutMs: number;
  enableSupervisor: boolean;
  explicitSessionKey?: string;
  userId: string;
  logDir: string;
  resultMaxChars: number;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  uptime: number;
  stores: {
    vectorStore: boolean;
    embeddingService: boolean;
  };
}

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

export interface ConversationSearchRequest {
  query: string;
  limit?: number;
  session_key?: string;
}

export interface ConversationSearchResponse {
  results: string;
  total: number;
}

export interface SessionEndRequest {
  session_key: string;
  user_id?: string;
}

export interface SessionEndResponse {
  flushed: boolean;
}

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

export interface OpenCodePart {
  id?: string;
  messageID?: string;
  type: string;
  text?: string;
  synthetic?: boolean;
  ignored?: boolean;
}

export interface OpenCodeMessage {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  parentID?: string;
  summary?: unknown;
  error?: unknown;
  finish?: string;
  time?: {
    created?: number;
    completed?: number;
  };
}

export interface OpenCodeMessageWithParts {
  info: OpenCodeMessage;
  parts: OpenCodePart[];
}

export interface CompletedOpenCodeTurn {
  userMessageId: string;
  assistantMessageId: string;
  userText: string;
  assistantText: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}
