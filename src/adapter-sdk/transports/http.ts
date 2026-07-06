/**
 * Adapter SDK — HTTP transport.
 *
 * `HttpMemoryClient` speaks the TDAI Gateway REST protocol
 * (`src/gateway/server.ts`), mirroring the Hermes Python client
 * (`hermes-plugin/memory/memory_tencentdb/client.py`) 1:1:
 *
 *   recall              → POST /recall
 *   capture             → POST /capture
 *   searchMemories      → POST /search/memories
 *   searchConversations → POST /search/conversations
 *   endSession          → POST /session/end
 *   health              → GET  /health
 *
 * camelCase ⇄ snake_case mapping happens ONLY in this file — the SDK surface
 * stays camelCase, the wire stays byte-compatible with the existing gateway.
 *
 * Search requests opportunistically send `include_items: true` (a protocol
 * extension added together with this SDK). Older gateways ignore unknown
 * fields and omit `items` in the response; we tolerate that by defaulting
 * `items` to `[]`, so this client works against any gateway version.
 */

import type { Logger } from "../../core/types.js";
import type {
  MemoryClient,
  RecallParams,
  RecallOutcome,
  CaptureParams,
  CaptureOutcome,
  SearchMemoriesParams,
  SearchMemoriesOutcome,
  SearchConversationsParams,
  SearchConversationsOutcome,
  HealthOutcome,
} from "../types.js";
import { MemoryClientError, codeForHttpStatus } from "../errors.js";

const TAG = "[tdai-adapter] [http]";

// ============================
// Options
// ============================

export interface HttpMemoryClientOptions {
  /** Gateway base URL. Default: `http://127.0.0.1:8420`. */
  baseUrl?: string;
  /**
   * Optional Bearer token. Attached as `Authorization: Bearer <key>` only
   * when non-empty after trimming — matching the Python client's behaviour.
   */
  apiKey?: string;
  /** Per-request timeout in milliseconds. Default: 10_000. */
  timeoutMs?: number;
  /** Injectable fetch implementation (unit tests). Default: global fetch. */
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:8420";
const DEFAULT_TIMEOUT_MS = 10_000;

// ============================
// HttpMemoryClient
// ============================

export class HttpMemoryClient implements MemoryClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: Logger;

  constructor(opts: HttpMemoryClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const trimmedKey = opts.apiKey?.trim();
    this.apiKey = trimmedKey ? trimmedKey : undefined;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Bind to globalThis so the native fetch keeps its receiver.
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.logger = opts.logger;
  }

  // ============================
  // MemoryClient implementation
  // ============================

  async recall(params: RecallParams): Promise<RecallOutcome> {
    const body = await this.post<{
      context?: string;
      strategy?: string;
      memory_count?: number;
      prepend_context?: string;
    }>("/recall", {
      query: params.query,
      session_key: params.sessionKey,
      user_id: params.userId ?? "",
    });
    return {
      context: body.context ?? "",
      prependContext: body.prepend_context,
      strategy: body.strategy,
      memoryCount: body.memory_count ?? 0,
    };
  }

  async capture(params: CaptureParams): Promise<CaptureOutcome> {
    const body = await this.post<{ l0_recorded?: number; scheduler_notified?: boolean }>(
      "/capture",
      {
        user_content: params.userContent,
        assistant_content: params.assistantContent,
        session_key: params.sessionKey,
        ...(params.sessionId !== undefined ? { session_id: params.sessionId } : {}),
        ...(params.userId !== undefined ? { user_id: params.userId } : {}),
        ...(params.messages !== undefined ? { messages: params.messages } : {}),
      },
    );
    return {
      l0Recorded: body.l0_recorded ?? 0,
      schedulerNotified: body.scheduler_notified ?? false,
    };
  }

  async searchMemories(params: SearchMemoriesParams): Promise<SearchMemoriesOutcome> {
    const body = await this.post<{
      results?: string;
      total?: number;
      strategy?: string;
      items?: SearchMemoriesOutcome["items"];
    }>("/search/memories", {
      query: params.query,
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
      ...(params.type !== undefined ? { type: params.type } : {}),
      ...(params.scene !== undefined ? { scene: params.scene } : {}),
      include_items: true,
    });
    return {
      text: body.results ?? "",
      total: body.total ?? 0,
      strategy: body.strategy ?? "none",
      items: body.items ?? [],
    };
  }

  async searchConversations(params: SearchConversationsParams): Promise<SearchConversationsOutcome> {
    const body = await this.post<{
      results?: string;
      total?: number;
      items?: SearchConversationsOutcome["items"];
    }>("/search/conversations", {
      query: params.query,
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
      ...(params.sessionKey !== undefined ? { session_key: params.sessionKey } : {}),
      include_items: true,
    });
    return {
      text: body.results ?? "",
      total: body.total ?? 0,
      items: body.items ?? [],
    };
  }

  async endSession(sessionKey: string): Promise<void> {
    await this.post("/session/end", { session_key: sessionKey });
  }

  async health(): Promise<HealthOutcome> {
    const body = await this.request<{
      status?: string;
      version?: string;
      stores?: { vectorStore?: boolean; embeddingService?: boolean };
    }>("GET", "/health");
    return {
      status: body.status === "ok" ? "ok" : "degraded",
      vectorStore: body.stores?.vectorStore ?? false,
      embeddingService: body.stores?.embeddingService ?? false,
      version: body.version,
    };
  }

  /** No remote resources are owned by this client — closing is a no-op. */
  async close(): Promise<void> {
    // no-op
  }

  // ============================
  // Wire helpers
  // ============================

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
      const message = isTimeout
        ? `Gateway request timed out after ${this.timeoutMs}ms: ${method} ${url}`
        : `Gateway unreachable: ${method} ${url}: ${err instanceof Error ? err.message : String(err)}`;
      this.logger?.warn(`${TAG} ${message}`);
      throw new MemoryClientError(isTimeout ? "transport" : "unavailable", message, { cause: err });
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = undefined;
    }

    if (!response.ok) {
      // Gateway error bodies are `{ error: string }` — surface the message.
      const detail =
        parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
          ? (parsed as { error: string }).error
          : text.slice(0, 200) || response.statusText;
      const code = codeForHttpStatus(response.status);
      this.logger?.warn(`${TAG} ${method} ${path} → HTTP ${response.status} (${code}): ${detail}`);
      throw new MemoryClientError(code, `Gateway ${method} ${path} failed (HTTP ${response.status}): ${detail}`, {
        httpStatus: response.status,
      });
    }

    if (parsed === undefined) {
      throw new MemoryClientError("transport", `Gateway ${method} ${path} returned invalid JSON`, {
        httpStatus: response.status,
      });
    }
    return parsed as T;
  }
}
