/**
 * GatewayClient — typed HTTP client for the TDAI Gateway.
 *
 * This is the TypeScript analog of the Hermes provider's `client.py`. It wraps
 * the Gateway REST contract (see `src/gateway/server.ts`) with a small, fully
 * typed surface. It uses Node's built-in `fetch` (Node >= 18) so the SDK has
 * ZERO runtime dependencies.
 *
 * Endpoints:
 *   GET  /health
 *   POST /recall
 *   POST /capture
 *   POST /search/memories
 *   POST /search/conversations
 *   POST /session/end
 */

import type {
  RecallInput,
  RecallOutput,
  CaptureInput,
  CaptureOutput,
  SessionEndInput,
  MemorySearchInput,
  ConversationSearchInput,
  SearchOutput,
  AdapterLogger,
} from "./types.js";

export interface GatewayClientOptions {
  /** Gateway base URL, e.g. "http://127.0.0.1:8420". */
  baseUrl: string;
  /** Optional Bearer token (matches Gateway's TDAI_GATEWAY_API_KEY). */
  apiKey?: string;
  /** Default request timeout in ms. */
  timeoutMs?: number;
  /** Optional logger. */
  logger?: AdapterLogger;
}

/** Shape of the Gateway `/health` response. */
export interface HealthResult {
  status: "ok" | "degraded";
  version: string;
  uptime: number;
  stores: { vectorStore: boolean; embeddingService: boolean };
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class GatewayClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly logger?: AdapterLogger;

  constructor(opts: GatewayClientOptions) {
    // Trim trailing slash so `${baseUrl}${path}` never doubles up.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = (opts.apiKey ?? "").trim() || undefined;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = opts.logger;
  }

  // -- transport ----------------------------------------------------------

  private buildHeaders(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {};
    if (hasBody) headers["Content-Type"] = "application/json";
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    return headers;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: this.buildHeaders(body !== undefined),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        this.logger?.warn(
          `[adapter-sdk] Gateway ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`,
        );
        throw new GatewayError(res.status, text || res.statusText);
      }
      return (text ? JSON.parse(text) : {}) as T;
    } catch (err) {
      if (err instanceof GatewayError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.debug?.(`[adapter-sdk] Gateway ${method} ${path} failed: ${msg}`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // -- API methods --------------------------------------------------------

  async health(timeoutMs = 3_000): Promise<HealthResult> {
    return this.request<HealthResult>("GET", "/health", undefined, timeoutMs);
  }

  async recall(input: RecallInput): Promise<RecallOutput> {
    const body: Record<string, unknown> = {
      query: input.query,
      session_key: input.sessionKey,
    };
    if (input.userId) body.user_id = input.userId;
    const res = await this.request<{
      context: string;
      strategy?: string;
      memory_count?: number;
    }>("POST", "/recall", body);
    return {
      context: res.context ?? "",
      strategy: res.strategy,
      memoryCount: res.memory_count ?? 0,
    };
  }

  async capture(input: CaptureInput): Promise<CaptureOutput> {
    const body: Record<string, unknown> = {
      user_content: input.userContent,
      assistant_content: input.assistantContent,
      session_key: input.sessionKey,
    };
    if (input.sessionId) body.session_id = input.sessionId;
    if (input.userId) body.user_id = input.userId;
    const res = await this.request<{
      l0_recorded: number;
      scheduler_notified: boolean;
    }>("POST", "/capture", body);
    return {
      l0Recorded: res.l0_recorded ?? 0,
      schedulerNotified: res.scheduler_notified ?? false,
    };
  }

  async searchMemories(input: MemorySearchInput): Promise<SearchOutput> {
    const body: Record<string, unknown> = { query: input.query };
    if (input.limit != null) body.limit = input.limit;
    if (input.type) body.type = input.type;
    if (input.scene) body.scene = input.scene;
    const res = await this.request<{ results: string; total: number; strategy: string }>(
      "POST",
      "/search/memories",
      body,
    );
    return { results: res.results ?? "", total: res.total ?? 0, strategy: res.strategy };
  }

  async searchConversations(input: ConversationSearchInput): Promise<SearchOutput> {
    const body: Record<string, unknown> = { query: input.query };
    if (input.limit != null) body.limit = input.limit;
    if (input.sessionKey) body.session_key = input.sessionKey;
    const res = await this.request<{ results: string; total: number }>(
      "POST",
      "/search/conversations",
      body,
    );
    return { results: res.results ?? "", total: res.total ?? 0 };
  }

  async endSession(input: SessionEndInput): Promise<{ flushed: boolean }> {
    const body: Record<string, unknown> = { session_key: input.sessionKey };
    if (input.userId) body.user_id = input.userId;
    return this.request<{ flushed: boolean }>("POST", "/session/end", body);
  }
}

/** Error thrown for non-2xx Gateway responses. */
export class GatewayError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`Gateway HTTP ${status}: ${message}`);
    this.name = "GatewayError";
  }
}
