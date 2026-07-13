import type {
  CaptureResponse,
  ConversationSearchResponse,
  HealthResponse,
  MemorySearchResponse,
  RecallResponse,
  SessionEndResponse,
} from "../../gateway/types.js";

export interface CodingAgentGatewayClientOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface CodingAgentTurn {
  userContent: string;
  assistantContent: string;
  sessionKey: string;
  sessionId?: string;
  userId?: string;
  messages?: unknown[];
  startedAt?: number;
}

export interface CodingAgentRecallRequest {
  query: string;
  sessionKey: string;
  userId?: string;
}

export interface CodingAgentMemorySearchRequest {
  query: string;
  limit?: number;
  type?: string;
  scene?: string;
}

export interface CodingAgentConversationSearchRequest {
  query: string;
  limit?: number;
  sessionKey?: string;
}

export class CodingAgentGatewayError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(status: number, responseBody: string) {
    super(`TDAI Gateway request failed with HTTP ${status}: ${responseBody}`);
    this.name = "CodingAgentGatewayError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

/**
 * Thin HTTP client for coding-agent platforms that connect to TDAI through
 * the Gateway sidecar instead of embedding TdaiCore in-process.
 */
export class CodingAgentGatewayClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: CodingAgentGatewayClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:8420").replace(/\/+$/, "");
    this.apiKey = options.apiKey?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/health");
  }

  recall(request: CodingAgentRecallRequest): Promise<RecallResponse> {
    return this.request<RecallResponse>("POST", "/recall", {
      query: request.query,
      session_key: request.sessionKey,
      ...(request.userId ? { user_id: request.userId } : {}),
    });
  }

  capture(turn: CodingAgentTurn): Promise<CaptureResponse> {
    return this.request<CaptureResponse>("POST", "/capture", {
      user_content: turn.userContent,
      assistant_content: turn.assistantContent,
      session_key: turn.sessionKey,
      ...(turn.sessionId ? { session_id: turn.sessionId } : {}),
      ...(turn.userId ? { user_id: turn.userId } : {}),
      ...(turn.messages ? { messages: turn.messages } : {}),
      ...(turn.startedAt !== undefined ? { started_at: turn.startedAt } : {}),
    });
  }

  searchMemories(request: CodingAgentMemorySearchRequest): Promise<MemorySearchResponse> {
    return this.request<MemorySearchResponse>("POST", "/search/memories", {
      query: request.query,
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
      ...(request.type ? { type: request.type } : {}),
      ...(request.scene ? { scene: request.scene } : {}),
    });
  }

  searchConversations(request: CodingAgentConversationSearchRequest): Promise<ConversationSearchResponse> {
    return this.request<ConversationSearchResponse>("POST", "/search/conversations", {
      query: request.query,
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
      ...(request.sessionKey ? { session_key: request.sessionKey } : {}),
    });
  }

  endSession(sessionKey: string, userId?: string): Promise<SessionEndResponse> {
    return this.request<SessionEndResponse>("POST", "/session/end", {
      session_key: sessionKey,
      ...(userId ? { user_id: userId } : {}),
    });
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) {
        throw new CodingAgentGatewayError(response.status, text);
      }
      return (text ? JSON.parse(text) : {}) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
