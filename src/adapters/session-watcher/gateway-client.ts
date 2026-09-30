/**
 * Gateway Memory Client — compatible with PR #316 canonical API.
 *
 * Mirrors the GatewayMemoryClient + createGatewayPlatformAdapter pattern
 * from TencentCloud/TencentDB-Agent-Memory#316 (RerankerGuo, approved).
 *
 * Types are self-contained (same shape as src/gateway/types.ts) to keep
 * this package independent from the parent AgentMemory project.
 */

// ═══ Gateway API Types (mirrors src/gateway/types.ts) ═══

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

export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  uptime: number;
  stores: { vectorStore: boolean; embeddingService: boolean };
}

// ═══ Client Options ═══════════════════════════════════

export interface GatewayMemoryClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface GatewayPlatformContext {
  sessionKey: string;
  sessionId?: string;
  userId?: string;
}

export interface GatewayPlatformAdapterOptions {
  client: GatewayMemoryClient;
  platform: string;
  resolveContext: () => GatewayPlatformContext | Promise<GatewayPlatformContext>;
}

export interface GatewayPlatformAdapter {
  readonly platform: string;
  prefetch(query: string): Promise<RecallResponse>;
  captureTurn(turn: {
    userText: string;
    assistantText: string;
    messages?: unknown[];
  }): Promise<CaptureResponse>;
  searchMemories(params: MemorySearchRequest): Promise<MemorySearchResponse>;
  searchConversations(
    params: Omit<ConversationSearchRequest, "session_key"> & {
      sessionKey?: string;
    },
  ): Promise<ConversationSearchResponse>;
  endSession(): Promise<SessionEndResponse>;
}

// ═══ Error Type ════════════════════════════════════════

export class GatewayMemoryClientError extends Error {
  readonly status: number;
  readonly path: string;
  readonly responseBody: string;

  constructor(path: string, status: number, responseBody: string) {
    super(`Gateway request failed: ${path} returned ${status}`);
    this.name = "GatewayMemoryClientError";
    this.path = path;
    this.status = status;
    this.responseBody = responseBody;
  }
}

// ═══ Client ════════════════════════════════════════════

export class GatewayMemoryClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GatewayMemoryClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/health");
  }

  recall(body: RecallRequest): Promise<RecallResponse> {
    return this.request<RecallResponse>("POST", "/recall", body);
  }

  capture(body: CaptureRequest): Promise<CaptureResponse> {
    return this.request<CaptureResponse>("POST", "/capture", body);
  }

  searchMemories(body: MemorySearchRequest): Promise<MemorySearchResponse> {
    return this.request<MemorySearchResponse>("POST", "/search/memories", body);
  }

  searchConversations(
    body: ConversationSearchRequest,
  ): Promise<ConversationSearchResponse> {
    return this.request<ConversationSearchResponse>(
      "POST",
      "/search/conversations",
      body,
    );
  }

  endSession(body: SessionEndRequest): Promise<SessionEndResponse> {
    return this.request<SessionEndResponse>("POST", "/session/end", body);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {};
      if (method === "POST") headers["Content-Type"] = "application/json";
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();

      if (!response.ok) {
        throw new GatewayMemoryClientError(path, response.status, text);
      }
      return (text ? JSON.parse(text) : {}) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ═══ Platform Adapter Helper ═══════════════════════════

export function createGatewayPlatformAdapter(
  opts: GatewayPlatformAdapterOptions,
): GatewayPlatformAdapter {
  return {
    platform: opts.platform,

    async prefetch(query: string): Promise<RecallResponse> {
      const ctx = await opts.resolveContext();
      return opts.client.recall({
        query,
        session_key: ctx.sessionKey,
        user_id: ctx.userId,
      });
    },

    async captureTurn(turn): Promise<CaptureResponse> {
      const ctx = await opts.resolveContext();
      return opts.client.capture({
        user_content: turn.userText,
        assistant_content: turn.assistantText,
        messages: turn.messages,
        session_key: ctx.sessionKey,
        session_id: ctx.sessionId,
        user_id: ctx.userId,
      });
    },

    searchMemories(params: MemorySearchRequest): Promise<MemorySearchResponse> {
      return opts.client.searchMemories(params);
    },

    async searchConversations(params): Promise<ConversationSearchResponse> {
      const ctx = await opts.resolveContext();
      return opts.client.searchConversations({
        query: params.query,
        limit: params.limit,
        session_key: params.sessionKey ?? ctx.sessionKey,
      });
    },

    async endSession(): Promise<SessionEndResponse> {
      const ctx = await opts.resolveContext();
      return opts.client.endSession({
        session_key: ctx.sessionKey,
        user_id: ctx.userId,
      });
    },
  };
}
