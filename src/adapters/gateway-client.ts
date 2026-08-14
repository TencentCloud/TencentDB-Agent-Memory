/**
 * GatewayMemoryClient — small HTTP client for external Agent platform adapters.
 *
 * It wraps the TDAI Gateway API exposed by src/gateway/server.ts so adapters
 * for Claude Code, Dify, Codex, or other hosts can focus on translating host
 * lifecycle events into recall/capture calls.
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
} from "../gateway/types.js";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface GatewayMemoryClientOptions {
  /** TDAI Gateway base URL, for example "http://127.0.0.1:8765". */
  baseUrl?: string;
  /** Optional shared secret configured via TDAI_GATEWAY_API_KEY. */
  apiKey?: string;
  /** Request timeout in milliseconds. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Test hook or custom fetch implementation. Defaults to global fetch. */
  fetchFn?: FetchLike;
}

export class GatewayMemoryClientError extends Error {
  readonly status: number;
  readonly responseBody: unknown;

  constructor(status: number, message: string, responseBody: unknown) {
    super(message);
    this.name = "GatewayMemoryClientError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

export class GatewayMemoryClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchLike;

  constructor(opts: GatewayMemoryClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://127.0.0.1:8765").replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/health");
  }

  async recall(query: string, sessionKey: string, userId?: string): Promise<RecallResponse> {
    return this.request<RecallResponse>("POST", "/recall", {
      query,
      session_key: sessionKey,
      ...(userId ? { user_id: userId } : {}),
    } satisfies RecallRequest);
  }

  async capture(params: CaptureRequest): Promise<CaptureResponse> {
    return this.request<CaptureResponse>("POST", "/capture", params);
  }

  async searchMemories(params: MemorySearchRequest): Promise<MemorySearchResponse> {
    return this.request<MemorySearchResponse>("POST", "/search/memories", params);
  }

  async searchConversations(params: ConversationSearchRequest): Promise<ConversationSearchResponse> {
    return this.request<ConversationSearchResponse>("POST", "/search/conversations", params);
  }

  async endSession(sessionKey: string, userId?: string): Promise<SessionEndResponse> {
    return this.request<SessionEndResponse>("POST", "/session/end", {
      session_key: sessionKey,
      ...(userId ? { user_id: userId } : {}),
    } satisfies SessionEndRequest);
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    try {
      const response = await this.fetchFn(new URL(path, `${this.baseUrl}/`), {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });

      const raw = await response.text();
      const parsed = raw ? parseJson(raw) : undefined;

      if (!response.ok) {
        const message = extractErrorMessage(parsed) ?? `Gateway request failed: ${response.status}`;
        throw new GatewayMemoryClientError(response.status, message, parsed);
      }

      return parsed as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function extractErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const error = (value as { error?: unknown }).error;
  return typeof error === "string" ? error : undefined;
}
