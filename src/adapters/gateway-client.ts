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

export interface GatewayRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface GatewayFetchResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}

export type GatewayFetch = (url: string, init?: GatewayRequestInit) => Promise<GatewayFetchResponse>;

export interface TdaiGatewayClientOptions {
  /** Gateway base URL, for example `http://127.0.0.1:8420`. */
  baseUrl: string;
  /** Optional Bearer token matching `TDAI_GATEWAY_API_KEY`. */
  apiKey?: string;
  /** Custom fetch implementation for non-standard runtimes or tests. */
  fetch?: GatewayFetch;
}

export interface GatewaySessionKeyParts {
  platform: string;
  userId?: string;
  conversationId?: string;
  sessionId?: string;
}

export class GatewayClientError extends Error {
  readonly status: number;
  readonly responseBody: unknown;

  constructor(status: number, message: string, responseBody: unknown) {
    super(message);
    this.name = "GatewayClientError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

export class TdaiGatewayClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchFn: GatewayFetch;

  constructor(opts: TdaiGatewayClientOptions) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetch ?? getGlobalFetch();
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

  sessionEnd(body: SessionEndRequest): Promise<SessionEndResponse> {
    return this.request<SessionEndResponse>("POST", "/session/end", body);
  }

  private async request<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await this.fetchFn(`${this.baseUrl}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = parseJsonOrText(text);

    if (!response.ok) {
      const message = typeof parsed === "object" && parsed !== null && "error" in parsed
        ? String((parsed as { error?: unknown }).error)
        : `Gateway request failed with HTTP ${response.status}`;
      throw new GatewayClientError(response.status, message, parsed);
    }

    return parsed as T;
  }
}

export function createGatewaySessionKey(parts: GatewaySessionKeyParts): string {
  const platform = sanitizeSessionKeyPart(parts.platform || "platform");
  const user = sanitizeSessionKeyPart(parts.userId || "default_user");
  const conversation = sanitizeSessionKeyPart(parts.conversationId || "default_conversation");
  const session = parts.sessionId ? `:${sanitizeSessionKeyPart(parts.sessionId)}` : "";
  return `${platform}:${user}:${conversation}${session}`;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) throw new Error("Gateway baseUrl is required");
  return trimmed.replace(/\/+$/, "");
}

function sanitizeSessionKeyPart(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitized || "unknown";
}

function parseJsonOrText(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function getGlobalFetch(): GatewayFetch {
  const fetchFn = globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("No fetch implementation available; pass `fetch` to TdaiGatewayClient");
  }
  return (url, init) => fetchFn(url, init as RequestInit) as Promise<GatewayFetchResponse>;
}
