import type {
  ConversationSearchRequest,
  ConversationSearchResponse,
  HealthResponse,
  MemorySearchRequest,
  MemorySearchResponse,
  RecallRequest,
  RecallResponse,
  SeedRequest,
  SeedResponse,
  SessionEndRequest,
  SessionEndResponse,
} from "../../gateway/types.js";

export type {
  ConversationSearchRequest,
  ConversationSearchResponse,
  HealthResponse,
  MemorySearchRequest,
  MemorySearchResponse,
  RecallRequest,
  RecallResponse,
  SeedRequest,
  SeedResponse,
  SessionEndRequest,
  SessionEndResponse,
};

export interface ClaudeCodeAdapterConfig {
  gatewayUrl: string;
  gatewayApiKey?: string;
  autoRecall: boolean;
  recallMaxChars: number;
  canvasMaxChars: number;
  shortTermEnabled: boolean;
  storageDir: string;
}

export interface ClaudeCodeHookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  user_prompt?: string;
  message?: {
    content?: string;
  };
  reason?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
  duration_ms?: number;
  [key: string]: unknown;
}

export interface ClaudeCodeUserPromptSubmitOutput {
  hookSpecificOutput?: {
    hookEventName: "UserPromptSubmit";
    additionalContext?: string;
  };
}

export interface ContextFormatOptions {
  recallMaxChars: number;
  canvasMaxChars: number;
}

export interface GatewayClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export interface MemorySearchToolArgs {
  query: string;
  limit?: number;
  type?: string;
  scene?: string;
}

export interface ConversationSearchToolArgs {
  query: string;
  limit?: number;
  session_key?: string;
}

export type ClaudeCodeMcpToolName =
  | "memory_tencentdb_memory_search"
  | "memory_tencentdb_conversation_search";

export interface ClaudeCodeSeedMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: number | string;
}

export interface ClaudeCodeSeedSession {
  sessionKey: string;
  sessionId?: string;
  conversations: ClaudeCodeSeedMessage[][];
}

export interface ClaudeCodeToolEvent {
  sessionKey: string;
  sessionId?: string;
  cwd?: string;
  toolUseId: string;
  toolName: string;
  status: "success" | "error";
  startedAt?: string;
  endedAt: string;
  durationMs?: number;
  inputSummary: string;
  resultSummary: string;
  rawInput?: unknown;
  rawResult?: unknown;
  resultRef?: string;
}

export interface ToolCaptureDecision {
  capture: boolean;
  reason: string;
  writeRef: boolean;
}

export interface ShortTermRecord {
  session_key: string;
  session_id?: string;
  cwd_hash: string;
  node_id: string;
  tool_use_id: string;
  tool_name: string;
  status: "success" | "error";
  started_at?: string;
  ended_at: string;
  duration_ms?: number;
  input_summary: string;
  result_summary: string;
  result_ref?: string;
  capture_reason: string;
}
