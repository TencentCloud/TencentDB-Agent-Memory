/**
 * Gateway client adapter for non-OpenClaw platforms.
 *
 * Platforms such as Codex, Claude Code, Dify, or custom LangGraph agents can
 * integrate with memory-tencentdb without linking OpenClaw or Hermes SDKs by
 * calling the local TDAI Gateway over HTTP. This module provides a small,
 * dependency-free adapter around the Gateway API and a host-neutral helper for
 * wiring platform lifecycle hooks to recall/capture/search operations.
 */

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

export interface GatewayMemoryClientOptions {
  /** Gateway base URL, for example `http://127.0.0.1:8420`. */
  baseUrl: string;
  /** Optional Bearer token when the Gateway is configured with an API key. */
  apiKey?: string;
  /** Per-request timeout in milliseconds. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Timeout for session-end flushes. Defaults to at least 180 seconds. */
  sessionEndTimeoutMs?: number;
  /** Test hook or platform-specific fetch implementation. */
  fetchImpl?: typeof fetch;
}

export interface GatewayPlatformContext {
  /** Stable conversation/session key used by TDAI for L0/L1 grouping. */
  sessionKey: string;
  /** Optional host-specific session id. */
  sessionId?: string;
  /** Optional user id. */
  userId?: string;
}

export interface GatewayPlatformAdapterOptions {
  client: GatewayMemoryClient;
  /** Host platform name used by callers for logging and diagnostics. */
  platform: string;
  /** Resolve the current session/user identity from the host runtime. */
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
  searchConversations(params: Omit<ConversationSearchRequest, "session_key"> & {
    sessionKey?: string;
  }): Promise<ConversationSearchResponse>;
  endSession(): Promise<SessionEndResponse>;
}

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

export class GatewayMemoryClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly sessionEndTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GatewayMemoryClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.sessionEndTimeoutMs = opts.sessionEndTimeoutMs ?? Math.max(this.timeoutMs, 180_000);
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

  searchConversations(body: ConversationSearchRequest): Promise<ConversationSearchResponse> {
    return this.request<ConversationSearchResponse>("POST", "/search/conversations", body);
  }

  endSession(body: SessionEndRequest): Promise<SessionEndResponse> {
    return this.request<SessionEndResponse>(
      "POST",
      "/session/end",
      body,
      this.sessionEndTimeoutMs,
    );
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

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
