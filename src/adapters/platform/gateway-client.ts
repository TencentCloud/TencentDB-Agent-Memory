import type {
  CaptureResponse,
  ConversationSearchResponse,
  MemorySearchResponse,
  RecallResponse,
  SeedResponse,
  SessionEndResponse,
} from "../../gateway/types.js";

export interface MemoryGatewayClientOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface MemoryRecallContext {
  context: string;
  prependContext: string;
  appendSystemContext: string;
  strategy?: string;
  memoryCount?: number;
}

export interface MemoryCapturePayload {
  userContent: string;
  assistantContent: string;
  sessionKey: string;
  sessionId?: string;
  userId?: string;
  messages?: unknown[];
}

export class MemoryGatewayClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: MemoryGatewayClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://127.0.0.1:8420").replace(/\/+$/, "");
    this.apiKey = opts.apiKey?.trim() || undefined;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async health(timeoutMs = 3_000): Promise<{ status: string; version: string; uptime: number }> {
    return this.get<{ status: string; version: string; uptime: number }>("/health", timeoutMs);
  }

  async recall(query: string, sessionKey: string, userId?: string, timeoutMs?: number): Promise<MemoryRecallContext> {
    const body: Record<string, unknown> = { query, session_key: sessionKey };
    if (userId) body.user_id = userId;
    const result = await this.post<RecallResponse>("/recall", body, timeoutMs);
    return {
      context: result.context ?? result.append_system_context ?? "",
      prependContext: result.prepend_context ?? "",
      appendSystemContext: result.append_system_context ?? result.context ?? "",
      strategy: result.strategy,
      memoryCount: result.memory_count,
    };
  }

  async capture(payload: MemoryCapturePayload, timeoutMs?: number): Promise<CaptureResponse> {
    const body: Record<string, unknown> = {
      user_content: payload.userContent,
      assistant_content: payload.assistantContent,
      session_key: payload.sessionKey,
      messages: payload.messages,
    };
    if (payload.sessionId) body.session_id = payload.sessionId;
    if (payload.userId) body.user_id = payload.userId;
    return this.post<CaptureResponse>("/capture", body, timeoutMs);
  }

  async searchMemories(params: {
    query: string;
    limit?: number;
    type?: string;
    scene?: string;
  }, timeoutMs?: number): Promise<MemorySearchResponse> {
    return this.post<MemorySearchResponse>("/search/memories", {
      query: params.query,
      limit: params.limit,
      type: params.type,
      scene: params.scene,
    }, timeoutMs);
  }

  async searchConversations(params: {
    query: string;
    limit?: number;
    sessionKey?: string;
  }, timeoutMs?: number): Promise<ConversationSearchResponse> {
    return this.post<ConversationSearchResponse>("/search/conversations", {
      query: params.query,
      limit: params.limit,
      session_key: params.sessionKey,
    }, timeoutMs);
  }

  async endSession(sessionKey: string, userId?: string, timeoutMs?: number): Promise<SessionEndResponse> {
    const body: Record<string, unknown> = { session_key: sessionKey };
    if (userId) body.user_id = userId;
    return this.post<SessionEndResponse>("/session/end", body, timeoutMs);
  }

  async seed(data: unknown, params?: {
    sessionKey?: string;
    strictRoundRole?: boolean;
    autoFillTimestamps?: boolean;
    configOverride?: Record<string, unknown>;
  }, timeoutMs = 300_000): Promise<SeedResponse> {
    const body: Record<string, unknown> = { data };
    if (params?.sessionKey) body.session_key = params.sessionKey;
    if (params?.strictRoundRole) body.strict_round_role = true;
    if (params?.autoFillTimestamps === false) body.auto_fill_timestamps = false;
    if (params?.configOverride) body.config_override = params.configOverride;
    return this.post<SeedResponse>("/seed", body, timeoutMs);
  }

  private async get<T>(path: string, timeoutMs?: number): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await this.fetchWithTimeout(url, {
      method: "GET",
      headers: this.buildHeaders(false),
    }, timeoutMs);
    return this.parseJson<T>(res);
  }

  private async post<T>(path: string, body: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: this.buildHeaders(true),
      body: JSON.stringify(body),
    }, timeoutMs);
    return this.parseJson<T>(res);
  }

  private buildHeaders(withJson: boolean): HeadersInit {
    const headers: Record<string, string> = {};
    if (withJson) headers["Content-Type"] = "application/json";
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
    const controller = new AbortController();
    const effectiveTimeout = timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${effectiveTimeout}ms`)), effectiveTimeout);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async parseJson<T>(res: Response): Promise<T> {
    const text = await res.text();
    if (!res.ok) {
      throw new Error(text || `HTTP ${res.status}`);
    }
    return JSON.parse(text) as T;
  }
}
