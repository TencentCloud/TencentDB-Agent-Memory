export interface ChatMessage {
  role: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown;
  [key: string]: unknown;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  [key: string]: unknown;
}

export interface RecallResponseCompat {
  /** Legacy Gateway response field. */
  context?: string;
  /** Dynamic per-turn context introduced by the focused MCP/Gateway work. */
  prepend_context?: string;
  /** Stable persona/navigation context introduced by the focused MCP/Gateway work. */
  append_system_context?: string;
  strategy?: string;
  memory_count?: number;
}

export interface CapturePayload {
  user_content: string;
  assistant_content: string;
  session_key: string;
  session_id?: string;
  user_id?: string;
  messages?: unknown[];
  /** Forward-compatible with the retry-safe Gateway capture proposal. */
  idempotency_key?: string;
}

export interface ModelProxyGateway {
  recall(input: {
    query: string;
    session_key: string;
    user_id?: string;
  }): Promise<RecallResponseCompat>;
  capture(input: CapturePayload): Promise<unknown>;
  endSession(input: {
    session_key: string;
    user_id?: string;
  }): Promise<unknown>;
}

export interface ModelProxyLogger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface SessionResolution {
  sessionKey: string;
  turnKey: string;
  tailHash: string;
  namespace: string;
  forked: boolean;
}
