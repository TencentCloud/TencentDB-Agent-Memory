import type {
  CaptureRequest,
  CaptureResponse,
  ConversationSearchRequest,
  ConversationSearchResponse,
  GatewayErrorResponse,
  HealthResponse,
  MemorySearchRequest,
  MemorySearchResponse,
  RecallRequest,
  RecallResponse,
  SessionEndRequest,
  SessionEndResponse,
} from "../../gateway/types.js";

export interface CodexMemoryAdapterOptions {
  gatewayUrl?: string;
  apiKey?: string;
  sessionKey: string;
  sessionId?: string;
  userId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
}

export interface CaptureTurnParams {
  userText: string;
  assistantText: string;
  messages?: unknown[];
  sessionKey?: string;
  sessionId?: string;
}

export interface SearchMemoriesParams {
  query: string;
  limit?: number;
  type?: string;
  scene?: string;
}

export interface SearchConversationsParams {
  query: string;
  limit?: number;
  sessionKey?: string;
}

export class GatewayHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(message);
    this.name = "GatewayHttpError";
  }
}

/**
 * Thin adapter for Codex/CLI-style agents that talk to the TDAI Gateway.
 *
 * It maps a host's turn lifecycle onto the Gateway endpoints:
 * - before prompt: `recall(query)`
 * - after turn: `captureTurn(...)`
 * - tools: `searchMemories(...)` / `searchConversations(...)`
 * - shutdown: `endSession()`
 */
export class CodexMemoryAdapter {
  private readonly gatewayUrl: string;
  private readonly apiKey?: string;
  private readonly sessionKey: string;
  private readonly sessionId?: string;
  private readonly userId?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: CodexMemoryAdapterOptions) {
    if (!options.sessionKey) {
      throw new Error("CodexMemoryAdapter requires a non-empty sessionKey");
    }

    this.gatewayUrl = (options.gatewayUrl ?? "http://127.0.0.1:8420").replace(/\/+$/, "");
    this.apiKey = options.apiKey?.trim() || undefined;
    this.sessionKey = options.sessionKey;
    this.sessionId = options.sessionId;
    this.userId = options.userId;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  health(): Promise<HealthResponse> {
    return this.request<undefined, HealthResponse>("GET", "/health");
  }

  recall(query: string, sessionKey = this.sessionKey): Promise<RecallResponse> {
    const body: RecallRequest = {
      query,
      session_key: sessionKey,
    };
    if (this.userId) body.user_id = this.userId;
    return this.request<RecallRequest, RecallResponse>("POST", "/recall", body);
  }

  async buildPromptContext(query: string, sessionKey = this.sessionKey): Promise<string> {
    const result = await this.recall(query, sessionKey);
    return result.context;
  }

  captureTurn(params: CaptureTurnParams): Promise<CaptureResponse> {
    const body: CaptureRequest = {
      user_content: params.userText,
      assistant_content: params.assistantText,
      session_key: params.sessionKey ?? this.sessionKey,
    };
    const sessionId = params.sessionId ?? this.sessionId;
    if (sessionId) body.session_id = sessionId;
    if (this.userId) body.user_id = this.userId;
    if (params.messages) body.messages = params.messages;
    return this.request<CaptureRequest, CaptureResponse>("POST", "/capture", body);
  }

  searchMemories(params: SearchMemoriesParams): Promise<MemorySearchResponse> {
    const body: MemorySearchRequest = {
      query: params.query,
      limit: params.limit,
      type: params.type,
      scene: params.scene,
    };
    return this.request<MemorySearchRequest, MemorySearchResponse>("POST", "/search/memories", body);
  }

  searchConversations(params: SearchConversationsParams): Promise<ConversationSearchResponse> {
    const body: ConversationSearchRequest = {
      query: params.query,
      limit: params.limit,
      session_key: params.sessionKey,
    };
    return this.request<ConversationSearchRequest, ConversationSearchResponse>("POST", "/search/conversations", body);
  }

  endSession(sessionKey = this.sessionKey): Promise<SessionEndResponse> {
    const body: SessionEndRequest = {
      session_key: sessionKey,
    };
    if (this.userId) body.user_id = this.userId;
    return this.request<SessionEndRequest, SessionEndResponse>("POST", "/session/end", body);
  }

  private async request<TRequest, TResponse>(
    method: "GET" | "POST",
    path: string,
    body?: TRequest,
  ): Promise<TResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {};
      if (method === "POST") headers["Content-Type"] = "application/json";
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

      const response = await this.fetchImpl(`${this.gatewayUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();

      if (!response.ok) {
        const parsed = parseJson<GatewayErrorResponse>(text);
        throw new GatewayHttpError(
          parsed?.error ?? `Gateway request failed: ${method} ${path}`,
          response.status,
          text,
        );
      }

      return (text ? JSON.parse(text) : {}) as TResponse;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
