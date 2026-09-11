/**
 * TdaiGatewayClient — typed, dependency-free HTTP client for the TDAI Gateway.
 *
 * This is the transport half of the unified adapter SDK. It wraps every
 * Gateway endpoint (`src/gateway/server.ts`) with a camelCase TypeScript API,
 * timeouts, bounded retries, Bearer auth, and typed errors — so a new platform
 * adapter never has to hand-roll `fetch` calls or reason about the wire format.
 *
 * It is the TypeScript sibling of the Hermes provider's Python
 * `MemoryTencentdbSdkClient` (`hermes-plugin/memory/memory_tencentdb/client.py`)
 * and speaks the exact same HTTP contract, so both language ecosystems share
 * one Gateway.
 *
 * Usage:
 *   const client = TdaiGatewayClient.fromEnv();          // reads TDAI_GATEWAY_URL / _API_KEY
 *   const client = new TdaiGatewayClient({ baseUrl: "http://127.0.0.1:8420" });
 *   const { context } = await client.recall("what's my name?", "session-1");
 *   await client.capture({ userContent: "hi", assistantContent: "hello", sessionKey: "session-1" });
 */

import type {
  HealthResponse,
  RecallResponse,
  CaptureResponse,
  MemorySearchResponse,
  ConversationSearchResponse,
  SessionEndResponse,
  SeedResponse,
} from "../gateway/types.js";

// ============================
// Public options & types
// ============================

/** Minimal logger — structurally compatible with the core `Logger`. */
export interface GatewayClientLogger {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

/** Injectable `fetch` implementation (defaults to the Node global). */
export type FetchLike = typeof fetch;

export interface TdaiGatewayClientOptions {
  /** Gateway base URL. Default: `http://127.0.0.1:8420`. */
  baseUrl?: string;
  /**
   * Optional Bearer token. When set, every request carries
   * `Authorization: Bearer <apiKey>`. Leave unset for an open Gateway
   * (the Gateway's documented legacy default).
   */
  apiKey?: string;
  /** Per-request timeout in milliseconds. Default: 15000. */
  timeoutMs?: number;
  /** Retry attempts on transient failures (network / 5xx / timeout). Default: 2. */
  retries?: number;
  /** Base backoff between retries in ms (exponential). Default: 250. */
  retryBackoffMs?: number;
  /** Override `fetch` (useful for tests). Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Optional logger for debug/warn traces. */
  logger?: GatewayClientLogger;
}

/** Parameters for {@link TdaiGatewayClient.capture}. */
export interface CaptureParams {
  userContent: string;
  assistantContent: string;
  sessionKey: string;
  sessionId?: string;
  userId?: string;
  /** Full message list; defaults to a [user, assistant] pair on the Gateway. */
  messages?: unknown[];
}

/** Parameters for {@link TdaiGatewayClient.searchMemories}. */
export interface SearchMemoriesParams {
  query: string;
  limit?: number;
  type?: string;
  scene?: string;
}

/** Parameters for {@link TdaiGatewayClient.searchConversations}. */
export interface SearchConversationsParams {
  query: string;
  limit?: number;
  sessionKey?: string;
}

/** Parameters for {@link TdaiGatewayClient.seed}. */
export interface SeedParams {
  data: unknown;
  sessionKey?: string;
  strictRoundRole?: boolean;
  autoFillTimestamps?: boolean;
  configOverride?: Record<string, unknown>;
  /** Seed can be slow — override the default 15s timeout (default here: 300000). */
  timeoutMs?: number;
}

// ============================
// Errors
// ============================

/**
 * Thrown for any non-2xx Gateway response or transport failure.
 *
 * `status` is the HTTP status (0 for network/timeout errors). `code` is a
 * stable machine-readable discriminant so adapters can branch on failure
 * class without string-matching messages.
 */
export class TdaiGatewayError extends Error {
  readonly status: number;
  readonly code: TdaiGatewayErrorCode;
  readonly path: string;
  /** Raw response body text, when available. */
  readonly body?: string;

  constructor(opts: {
    message: string;
    status: number;
    code: TdaiGatewayErrorCode;
    path: string;
    body?: string;
    cause?: unknown;
  }) {
    super(opts.message, { cause: opts.cause });
    this.name = "TdaiGatewayError";
    this.status = opts.status;
    this.code = opts.code;
    this.path = opts.path;
    this.body = opts.body;
  }
}

export type TdaiGatewayErrorCode =
  | "timeout"
  | "network"
  | "unauthorized"
  | "bad_request"
  | "not_found"
  | "server_error"
  | "invalid_json"
  | "unknown";

const DEFAULTS = {
  baseUrl: "http://127.0.0.1:8420",
  timeoutMs: 15_000,
  retries: 2,
  retryBackoffMs: 250,
} as const;

// ============================
// TdaiGatewayClient
// ============================

export class TdaiGatewayClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryBackoffMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly logger?: GatewayClientLogger;

  constructor(opts: TdaiGatewayClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULTS.baseUrl).replace(/\/+$/, "");
    // Trim defensively — env vars often carry trailing newlines from `echo`
    // or YAML quoting, which would break an exact-match Bearer comparison.
    this.apiKey = opts.apiKey?.trim() || undefined;
    this.timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
    this.retries = Math.max(0, opts.retries ?? DEFAULTS.retries);
    this.retryBackoffMs = opts.retryBackoffMs ?? DEFAULTS.retryBackoffMs;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.logger = opts.logger;

    if (typeof this.fetchImpl !== "function") {
      throw new Error(
        "TdaiGatewayClient: global fetch is unavailable. Use Node >= 18, or pass opts.fetch.",
      );
    }
  }

  /**
   * Build a client from environment variables:
   *   TDAI_GATEWAY_URL      (default http://127.0.0.1:8420)
   *   TDAI_GATEWAY_API_KEY  (optional Bearer token)
   *   TDAI_GATEWAY_TIMEOUT_MS (optional)
   * Also accepts the Hermes-namespaced fallbacks used by the Python provider.
   */
  static fromEnv(overrides: TdaiGatewayClientOptions = {}): TdaiGatewayClient {
    const env = globalThis.process?.env ?? {};
    const host = env.MEMORY_TENCENTDB_GATEWAY_HOST;
    const port = env.MEMORY_TENCENTDB_GATEWAY_PORT;
    const hermesUrl = host || port ? `http://${host || "127.0.0.1"}:${port || "8420"}` : undefined;
    const timeoutRaw = env.TDAI_GATEWAY_TIMEOUT_MS;
    const timeoutMs = timeoutRaw && /^\d+$/.test(timeoutRaw.trim()) ? Number(timeoutRaw.trim()) : undefined;

    return new TdaiGatewayClient({
      baseUrl: env.TDAI_GATEWAY_URL || hermesUrl || DEFAULTS.baseUrl,
      apiKey:
        env.TDAI_GATEWAY_API_KEY ||
        env.MEMORY_TENCENTDB_GATEWAY_API_KEY ||
        undefined,
      timeoutMs,
      ...overrides,
    });
  }

  // -- API methods ----------------------------------------------------------

  /** `GET /health` — liveness/readiness probe. */
  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/health", undefined, { timeoutMs: 3_000, retries: 0 });
  }

  /** `POST /recall` — retrieve memory context for a query (prefetch). */
  recall(query: string, sessionKey: string, userId?: string): Promise<RecallResponse> {
    return this.request<RecallResponse>("POST", "/recall", {
      query,
      session_key: sessionKey,
      ...(userId ? { user_id: userId } : {}),
    });
  }

  /** `POST /capture` — persist a completed conversation turn (sync_turn). */
  capture(params: CaptureParams): Promise<CaptureResponse> {
    return this.request<CaptureResponse>("POST", "/capture", {
      user_content: params.userContent,
      assistant_content: params.assistantContent,
      session_key: params.sessionKey,
      ...(params.sessionId ? { session_id: params.sessionId } : {}),
      ...(params.userId ? { user_id: params.userId } : {}),
      ...(params.messages ? { messages: params.messages } : {}),
    });
  }

  /** `POST /search/memories` — search L1 structured memories. */
  searchMemories(params: SearchMemoriesParams): Promise<MemorySearchResponse> {
    return this.request<MemorySearchResponse>("POST", "/search/memories", {
      query: params.query,
      ...(params.limit != null ? { limit: params.limit } : {}),
      ...(params.type ? { type: params.type } : {}),
      ...(params.scene ? { scene: params.scene } : {}),
    });
  }

  /** `POST /search/conversations` — search L0 raw conversation history. */
  searchConversations(params: SearchConversationsParams): Promise<ConversationSearchResponse> {
    return this.request<ConversationSearchResponse>("POST", "/search/conversations", {
      query: params.query,
      ...(params.limit != null ? { limit: params.limit } : {}),
      ...(params.sessionKey ? { session_key: params.sessionKey } : {}),
    });
  }

  /** `POST /session/end` — flush a single session's buffered pipeline work. */
  endSession(sessionKey: string, userId?: string): Promise<SessionEndResponse> {
    return this.request<SessionEndResponse>("POST", "/session/end", {
      session_key: sessionKey,
      ...(userId ? { user_id: userId } : {}),
    });
  }

  /** `POST /seed` — batch-ingest historical conversations (L0 → L1). */
  seed(params: SeedParams): Promise<SeedResponse> {
    return this.request<SeedResponse>(
      "POST",
      "/seed",
      {
        data: params.data,
        ...(params.sessionKey ? { session_key: params.sessionKey } : {}),
        ...(params.strictRoundRole ? { strict_round_role: true } : {}),
        ...(params.autoFillTimestamps === false ? { auto_fill_timestamps: false } : {}),
        ...(params.configOverride ? { config_override: params.configOverride } : {}),
      },
      { timeoutMs: params.timeoutMs ?? 300_000 },
    );
  }

  // -- Transport ------------------------------------------------------------

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    override?: { timeoutMs?: number; retries?: number },
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const timeoutMs = override?.timeoutMs ?? this.timeoutMs;
    const maxRetries = override?.retries ?? this.retries;

    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    let lastErr: TdaiGatewayError | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.retryBackoffMs * 2 ** (attempt - 1);
        this.logger?.debug?.(`[tdai-sdk] retry ${attempt}/${maxRetries} ${method} ${path} after ${delay}ms`);
        await sleep(delay);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        const text = await res.text();
        if (!res.ok) {
          const err = toHttpError(res.status, path, text);
          // Retry only transient server-side failures; surface 4xx immediately.
          if (err.code === "server_error" && attempt < maxRetries) {
            lastErr = err;
            continue;
          }
          throw err;
        }

        return parseJson<T>(text, path);
      } catch (err) {
        if (err instanceof TdaiGatewayError) {
          if (err.code === "invalid_json" || err.code === "bad_request" ||
              err.code === "unauthorized" || err.code === "not_found") {
            throw err; // non-retryable
          }
          lastErr = err;
        } else {
          // fetch rejected: abort (timeout) or network failure.
          const isAbort = (err as { name?: string })?.name === "AbortError";
          lastErr = new TdaiGatewayError({
            message: isAbort
              ? `Gateway request timed out after ${timeoutMs}ms: ${method} ${path}`
              : `Gateway request failed: ${method} ${path}: ${errMessage(err)}`,
            status: 0,
            code: isAbort ? "timeout" : "network",
            path,
            cause: err,
          });
        }
        if (attempt >= maxRetries) throw lastErr;
      } finally {
        clearTimeout(timer);
      }
    }

    // Unreachable in practice — the loop either returns or throws.
    throw lastErr ?? new TdaiGatewayError({ message: `Gateway request failed: ${method} ${path}`, status: 0, code: "unknown", path });
  }
}

// ============================
// Helpers
// ============================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseJson<T>(text: string, path: string): T {
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new TdaiGatewayError({
      message: `Gateway returned non-JSON body for ${path}`,
      status: 200,
      code: "invalid_json",
      path,
      body: text.slice(0, 500),
      cause: err,
    });
  }
}

function toHttpError(status: number, path: string, body: string): TdaiGatewayError {
  let code: TdaiGatewayErrorCode = "unknown";
  if (status === 401 || status === 403) code = "unauthorized";
  else if (status === 400 || status === 422) code = "bad_request";
  else if (status === 404) code = "not_found";
  else if (status >= 500) code = "server_error";

  // The Gateway encodes errors as `{ error: string }`.
  let detail = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body) as { error?: string };
    if (parsed?.error) detail = parsed.error;
  } catch {
    /* keep raw body slice */
  }

  return new TdaiGatewayError({
    message: `Gateway ${status} on ${path}: ${detail}`,
    status,
    code,
    path,
    body,
  });
}
