/**
 * Gateway client adapter for non-OpenClaw platforms.
 *
 * Platforms such as Codex, Claude Code, Dify, or custom LangGraph agents can
 * integrate with memory-tencentdb without linking OpenClaw or Hermes SDKs by
 * calling the local TDAI Gateway over HTTP. This module provides a small,
 * dependency-free adapter around the Gateway API and a host-neutral helper for
 * wiring platform lifecycle hooks to recall/capture/search operations.
 *
 * ─── Architecture ──────────────────────────────────────────────────────────
 *
 *   New platform hooks/tools
 *           |
 *           v
 *   GatewayMemoryClient + createGatewayPlatformAdapter
 *           |
 *           v
 *   TDAI Gateway HTTP API
 *           |
 *           v
 *   StandaloneHostAdapter → TdaiCore
 *
 * ─── Usage ─────────────────────────────────────────────────────────────────
 *
 * ```ts
 * import { GatewayMemoryClient, createGatewayPlatformAdapter } from "./index.js";
 *
 * const client = new GatewayMemoryClient({
 *   baseUrl: "http://127.0.0.1:8420",
 *   apiKey: "your-api-key",
 * });
 *
 * // Low-level API:
 * const recall = await client.recall({ query: "hello", session_key: "sess-1" });
 *
 * // Or with lifecycle helper:
 * const memory = createGatewayPlatformAdapter({
 *   client,
 *   platform: "my-platform",
 *   resolveContext: () => ({ sessionKey: "sess-1", userId: "user-1" }),
 * });
 * await memory.prefetch("hello");
 * ```
 *
 * @see createGatewayPlatformAdapter — lifecycle helper for hook→API mapping
 * @see GatewayMemoryClient — low-level HTTP client
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

// ============================
// Types
// ============================

export interface GatewayMemoryClientOptions {
  /** Gateway base URL, for example `http://127.0.0.1:8420`. */
  baseUrl: string;
  /** Optional Bearer token when the Gateway is configured with an API key. */
  apiKey?: string;
  /** Per-request timeout in milliseconds. Defaults to 10 seconds. */
  timeoutMs?: number;
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
  searchConversations(
    params: Omit<ConversationSearchRequest, "session_key"> & { sessionKey?: string },
  ): Promise<ConversationSearchResponse>;
  endSession(): Promise<SessionEndResponse>;
}

// ============================
// Errors
// ============================

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

// ============================
// GatewayMemoryClient
// ============================

/**
 * Dependency-free HTTP client for the TDAI Gateway API.
 *
 * Supports all Gateway routes:
 * - `/health` (GET)
 * - `/recall`, `/capture`, `/search/memories`, `/search/conversations`, `/session/end` (POST)
 *
 * Uses native `fetch`, supports Bearer auth, and throws
 * `GatewayMemoryClientError` with the HTTP status and response body when
 * the Gateway rejects a request.
 */
export class GatewayMemoryClient {
  /** Gateway base URL (normalized). */
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GatewayMemoryClientOptions) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Check Gateway health. */
  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/health");
  }

  /** Recall memories relevant to a user query. */
  recall(body: RecallRequest): Promise<RecallResponse> {
    return this.request<RecallResponse>("POST", "/recall", body);
  }

  /** Capture a completed conversation turn. */
  capture(body: CaptureRequest): Promise<CaptureResponse> {
    return this.request<CaptureResponse>("POST", "/capture", body);
  }

  /** Search L1 structured memories. */
  searchMemories(body: MemorySearchRequest): Promise<MemorySearchResponse> {
    return this.request<MemorySearchResponse>("POST", "/search/memories", body);
  }

  /** Search L0 raw conversations. */
  searchConversations(body: ConversationSearchRequest): Promise<ConversationSearchResponse> {
    return this.request<ConversationSearchResponse>("POST", "/search/conversations", body);
  }

  /** End a session and flush buffered state. */
  endSession(body: SessionEndRequest): Promise<SessionEndResponse> {
    return this.request<SessionEndResponse>("POST", "/session/end", body);
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {};
      if (method === "POST") {
        headers["Content-Type"] = "application/json";
        headers["Accept"] = "application/json";
      }
      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        signal: controller.signal,
      });

      const payload = await readJsonResponse(response);

      if (!response.ok) {
        const errBody = asRecord(payload);
        throw new GatewayMemoryClientError(
          path,
          response.status,
          typeof errBody?.error === "string" ? errBody.error : JSON.stringify(payload),
        );
      }

      if (!asRecord(payload)) {
        throw new GatewayMemoryClientError(
          path,
          response.status,
          "Gateway returned a non-object JSON response",
        );
      }

      return payload as T;
    } catch (error) {
      if (error instanceof GatewayMemoryClientError) throw error;
      if (controller.signal.aborted) {
        throw new GatewayMemoryClientError(path, 0, `Request timed out after ${this.timeoutMs}ms`);
      }
      throw new GatewayMemoryClientError(
        path,
        0,
        `Network error: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

// ============================
// createGatewayPlatformAdapter
// ============================

/**
 * Create a lightweight lifecycle adapter from a GatewayMemoryClient.
 *
 * Maps host platform lifecycle events to Gateway API calls:
 *
 * | Host event        | Adapter call    | Gateway route        |
 * |-------------------|-----------------|----------------------|
 * | before-prompt     | `prefetch()`    | `POST /recall`       |
 * | after-turn        | `captureTurn()` | `POST /capture`      |
 * | search memories   | `searchMemories()` | `POST /search/memories` |
 * | search convos     | `searchConversations()` | `POST /search/conversations` |
 * | session end       | `endSession()`  | `POST /session/end`  |
 *
 * @example
 * ```ts
 * const memory = createGatewayPlatformAdapter({
 *   client: new GatewayMemoryClient({ baseUrl: "http://127.0.0.1:8420" }),
 *   platform: "codex",
 *   resolveContext: () => ({ sessionKey: "default" }),
 * });
 * const result = await memory.prefetch("user query");
 * ```
 */
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

    async searchConversations(
      params: Omit<ConversationSearchRequest, "session_key"> & { sessionKey?: string },
    ): Promise<ConversationSearchResponse> {
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

// ============================
// URL and response validation
// ============================

/**
 * Normalize and validate a Gateway base URL.
 *
 * Security checks (aligned with PR #372):
 * - Must use http or https scheme
 * - Must not contain embedded credentials
 * - Must not contain query string or fragment
 */
function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid TDAI Gateway URL: ${value}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("TDAI Gateway URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("TDAI Gateway URL must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new Error("TDAI Gateway URL must not contain a query or fragment");
  }

  return value.replace(/\/+$/, "");
}

/**
 * Parse the response body as JSON, handling empty and invalid responses.
 */
async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GatewayMemoryClientError(
      response.url ? new URL(response.url).pathname : "/unknown",
      response.status,
      `Gateway returned invalid JSON: ${text.slice(0, 200)}`,
    );
  }
}

/** Type guard: is the value a plain object (not null, not array)? */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
