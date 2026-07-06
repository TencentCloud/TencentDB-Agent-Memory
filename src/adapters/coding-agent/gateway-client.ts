import type {
  CaptureRequest,
  CaptureResponse,
  ConversationSearchRequest,
  ConversationSearchResponse,
  HealthResponse,
  MemorySearchRequest,
  MemorySearchResponse,
  RecallRequest,
  RecallResponse,
  SessionEndRequest,
  SessionEndResponse,
} from "../../gateway/types.js";

export interface CodingAgentGatewayClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export interface CodingAgentMemorySession {
  sessionKey: string;
  userId?: string;
  platform?: "codex" | "claude-code" | string;
}

export interface CodingAgentCaptureInput {
  session: CodingAgentMemorySession;
  userContent: string;
  assistantContent: string;
  sessionId?: string;
  messages?: unknown[];
}

export interface CodingAgentMemorySearchInput {
  query: string;
  limit?: number;
  type?: string;
  scene?: string;
}

export interface CodingAgentConversationSearchInput {
  query: string;
  limit?: number;
  sessionKey?: string;
}

export class GatewayClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = "GatewayClientError";
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new Error("CodingAgentGatewayClient requires a non-empty baseUrl");
  }
  return trimmed.replace(/\/+$/, "");
}

/**
 * Thin Gateway-backed adapter client for coding-agent integrations.
 *
 * Codex and Claude Code do not currently share one stable in-process plugin
 * surface. This client keeps the first integration path host-neutral: platform
 * wrappers only need to derive a session key and call the Gateway endpoints.
 */
export class CodingAgentGatewayClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultHeaders: Record<string, string>;

  constructor(options: CodingAgentGatewayClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.defaultHeaders = {
      ...(options.headers ?? {}),
    };

    if (options.apiKey) {
      this.defaultHeaders.Authorization = `Bearer ${options.apiKey}`;
    }
  }

  async health(): Promise<HealthResponse> {
    return this.request<undefined, HealthResponse>("GET", "/health");
  }

  async recall(query: string, session: CodingAgentMemorySession): Promise<RecallResponse> {
    const body: RecallRequest = {
      query,
      session_key: session.sessionKey,
      user_id: session.userId,
    };
    return this.request<RecallRequest, RecallResponse>("POST", "/recall", body);
  }

  async capture(input: CodingAgentCaptureInput): Promise<CaptureResponse> {
    const body: CaptureRequest = {
      user_content: input.userContent,
      assistant_content: input.assistantContent,
      session_key: input.session.sessionKey,
      session_id: input.sessionId,
      user_id: input.session.userId,
      messages: input.messages,
    };
    return this.request<CaptureRequest, CaptureResponse>("POST", "/capture", body);
  }

  async searchMemories(input: CodingAgentMemorySearchInput): Promise<MemorySearchResponse> {
    const body: MemorySearchRequest = {
      query: input.query,
      limit: input.limit,
      type: input.type,
      scene: input.scene,
    };
    return this.request<MemorySearchRequest, MemorySearchResponse>("POST", "/search/memories", body);
  }

  async searchConversations(input: CodingAgentConversationSearchInput): Promise<ConversationSearchResponse> {
    const body: ConversationSearchRequest = {
      query: input.query,
      limit: input.limit,
      session_key: input.sessionKey,
    };
    return this.request<ConversationSearchRequest, ConversationSearchResponse>("POST", "/search/conversations", body);
  }

  async endSession(session: CodingAgentMemorySession): Promise<SessionEndResponse> {
    const body: SessionEndRequest = {
      session_key: session.sessionKey,
      user_id: session.userId,
    };
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
      const headers: Record<string, string> = {
        ...this.defaultHeaders,
      };
      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (method === "POST") {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body ?? {});
      }

      const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
      const text = await response.text();

      if (!response.ok) {
        throw new GatewayClientError(`Gateway request failed: ${response.status} ${response.statusText}`, response.status, text);
      }

      return (text ? JSON.parse(text) : {}) as TResponse;
    } finally {
      clearTimeout(timeout);
    }
  }
}
