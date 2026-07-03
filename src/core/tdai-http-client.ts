/**
 * TdaiHttpClient 鈥?HTTP client for TDAI Gateway v2 REST API.
 *
 * TypeScript equivalent of bridge_adapter/client.py.
 * Provides typed wrappers for all Gateway endpoints consumed by adapters.
 *
 * Usage:
 *   const client = new TdaiHttpClient();
 *   const health = await client.health();
 *   const ctx = await client.recall("user query", 5);
 */

const DEFAULT_ENDPOINT = "http://127.0.0.1:8420";
const DEFAULT_SERVICE_ID = "mem-rkgqhd5z";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface TdaiHttpClientOptions {
  endpoint?: string;
  apiKey?: string;
  serviceId?: string;
  timeoutMs?: number;
}

/** Structured error from Gateway responses. */
export class TdaiHttpError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "TdaiHttpError";
  }
}

export class TdaiConnectionError extends TdaiHttpError {
  constructor(message: string, cause?: Error) {
    super(message, 0, cause);
    this.name = "TdaiConnectionError";
  }
}

export class TdaiAuthError extends TdaiHttpError {
  constructor(message: string) {
    super(message, 401);
    this.name = "TdaiAuthError";
  }
}

export class TdaiRateLimitError extends TdaiHttpError {
  constructor(message: string, public readonly retryAfter?: number) {
    super(message, 429);
    this.name = "TdaiRateLimitError";
  }
}

export class TdaiValidationError extends TdaiHttpError {
  constructor(message: string) {
    super(message, 400);
    this.name = "TdaiValidationError";
  }
}

export class TdaiTimeoutError extends TdaiHttpError {
  constructor(message: string, cause?: Error) {
    super(message, 0, cause);
    this.name = "TdaiTimeoutError";
  }
}

export class TdaiServerError extends TdaiHttpError {
  constructor(message: string, statusCode: number) {
    super(message, statusCode);
    this.name = "TdaiServerError";
  }
}

export class TdaiNotFoundError extends TdaiHttpError {
  constructor(message: string) {
    super(message, 404);
    this.name = "TdaiNotFoundError";
  }
}

function classifyError(status: number, body: string, cause?: Error): TdaiHttpError {
  const msg = body ? `${status}: ${body.slice(0, 200)}` : `HTTP ${status}`;
  if (status === 0 || status === 502 || status === 503 || status === 504) {
    return new TdaiConnectionError(msg, cause);
  }
  if (status === 401 || status === 403) return new TdaiAuthError(msg);
  if (status === 429) {
    const retryAfter = body.includes("retry_after") ? parseInt(body.match(/retry_after["':\s]*(\d+)/)?.[1] ?? "30", 10) : undefined;
    return new TdaiRateLimitError(msg, retryAfter);
  }
  if (status === 400 || status === 422) return new TdaiValidationError(msg);
  if (status === 404) return new TdaiNotFoundError(msg);
  if (status >= 500) return new TdaiServerError(msg, status);
  return new TdaiHttpError(msg, status);
}

export class TdaiHttpClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(opts: TdaiHttpClientOptions = {}) {
    this.baseUrl = (opts.endpoint ?? process.env.TDAI_ENDPOINT ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
    const apiKey = opts.apiKey ?? process.env.TDAI_API_KEY ?? "";
    const serviceId = opts.serviceId ?? process.env.TDAI_SERVICE_ID ?? DEFAULT_SERVICE_ID;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.headers = {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      "x-tdai-service-id": serviceId,
    };
  }

  private async _request<T>(path: string, payload?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: payload !== undefined ? "POST" : "GET",
        headers: this.headers,
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) throw classifyError(response.status, text);

      return JSON.parse(text) as T;
    } catch (err) {
      if (err instanceof TdaiHttpError) throw err;
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new TdaiTimeoutError(`Request timed out after ${this.timeoutMs}ms`);
      }
      throw new TdaiConnectionError(`Request failed: ${(err as Error).message}`, err as Error);
    } finally {
      clearTimeout(timer);
    }
  }

  // 鈹€鈹€ Public API 鈹€鈹€

  /** GET /health 鈥?Gateway health check. */
  async health(): Promise<{ status: string; uptime: number; stores: Record<string, string> }> {
    return this._request("/health");
  }

  /** POST /v2/conversation/add 鈥?Store a conversation turn. */
  async addConversation(sessionId: string, messages: Array<{ role: string; content: string }>): Promise<Record<string, unknown>> {
    return this._request("/v2/conversation/add", { session_id: sessionId, messages });
  }

  /** POST /v2/conversation/query 鈥?Retrieve conversation history. */
  async queryConversation(sessionId: string, limit = 10): Promise<Record<string, unknown>> {
    return this._request("/v2/conversation/query", { session_id: sessionId, limit });
  }

  /** POST /v2/conversation/search 鈥?Full-text search in conversations. */
  async searchConversation(query: string, limit = 5): Promise<Record<string, unknown>> {
    return this._request("/v2/conversation/search", { query, limit });
  }

  /** POST /v2/atomic/search 鈥?Search L1 atomic memories. */
  async searchAtomic(query: string, limit = 5): Promise<Record<string, unknown>> {
    return this._request("/v2/atomic/search", { query, limit });
  }

  /** POST /v2/scenario/ls 鈥?List L2 scene blocks. */
  async listScenarios(): Promise<Record<string, unknown>> {
    return this._request("/v2/scenario/ls", {});
  }

  /** POST /v2/core/read 鈥?Read L3 persona data. */
  async readCore(): Promise<Record<string, unknown>> {
    return this._request("/v2/core/read", {});
  }

  /** POST /v2/core/update 鈥?Update L3 persona data. */
  async updateCore(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this._request("/v2/core/update", data);
  }
}
