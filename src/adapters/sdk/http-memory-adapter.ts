/**
 * HttpMemoryAdapter — a `MemoryAdapter` that talks to the TDAI HTTP Gateway.
 *
 * This is the adapter for Agent platforms that can make HTTP requests but do
 * not run in the same Node process as the core (Codex, Dify, LangGraph-style
 * orchestrators, or any custom agent runtime). The platform points this
 * adapter at a running Gateway (`src/gateway/server.ts`) and immediately gets
 * the full memory read/write surface.
 *
 * Transport: plain `fetch` (Node ≥ 22 has a global fetch). Optional
 * `Authorization: Bearer <apiKey>` header is sent when an apiKey is configured
 * — the Gateway enforces the same secret.
 *
 * Field-name mapping: the Gateway speaks snake_case (`session_key`,
 * `user_content`, …); `MemoryAdapter` and the core speak camelCase. This
 * adapter is the single place that translation happens, so platform code never
 * sees snake_case.
 */

import type {
  CaptureResult,
  ConversationSearchParams,
  MemorySearchParams,
  RecallResult,
} from "../../core/types.js";
import type {
  CaptureTurn,
  ConversationSearchOutcome,
  HealthCheckResult,
  MemoryAdapter,
  MemorySearchOutcome,
} from "./types.js";
import { MemoryAdapterError } from "./types.js";

export interface HttpMemoryAdapterOptions {
  /** Base URL of the TDAI Gateway, e.g. `http://127.0.0.1:8420`. */
  baseUrl: string;
  /** Optional shared secret sent as `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  /** Optional default user id (forwarded as `user_id`). */
  defaultUserId?: string;
  /** Request timeout in ms (default: 30_000). */
  timeoutMs?: number;
  /**
   * Custom fetch (for testing / proxies). Defaults to `globalThis.fetch`.
   * Must be Node 22+ `fetch`-compatible.
   */
  fetchImpl?: typeof globalThis.fetch;
}

// Minimal slice of the Gateway's typed responses — kept local so this module
// has no import dependency on `src/gateway` (the SDK must stand alone).
interface GatewayRecallResponse {
  context: string;
  strategy?: string;
  memory_count?: number;
}
interface GatewayCaptureResponse {
  l0_recorded: number;
  scheduler_notified: boolean;
}
interface GatewayMemorySearchResponse {
  results: string;
  total: number;
  strategy: string;
}
interface GatewayConversationSearchResponse {
  results: string;
  total: number;
}
interface GatewaySessionEndResponse {
  flushed: boolean;
}
interface GatewayHealthResponse {
  status: "ok" | "degraded";
  version: string;
  uptime: number;
  stores: { vectorStore: boolean; embeddingService: boolean };
}

export class HttpMemoryAdapter implements MemoryAdapter {
  readonly kind = "http";

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly defaultUserId?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private initialized = false;

  constructor(opts: HttpMemoryAdapterOptions) {
    if (!opts || !opts.baseUrl) {
      throw new MemoryAdapterError("HttpMemoryAdapter requires `baseUrl`", {
        code: "BAD_CONFIG",
      });
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.defaultUserId = opts.defaultUserId;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    // Probe /health once so misconfiguration (wrong port, missing key) fails
    // fast at startup rather than on the first real recall/capture.
    try {
      await this.healthCheck();
      this.initialized = true;
    } catch (err) {
      throw err instanceof MemoryAdapterError
        ? err
        : new MemoryAdapterError(
            `HttpMemoryAdapter initialize failed: ${err instanceof Error ? err.message : String(err)}`,
            { code: "INIT_FAILED", cause: err },
          );
    }
  }

  async destroy(): Promise<void> {
    // HTTP is stateless — nothing to close.
    this.initialized = false;
  }

  async recall(query: string, sessionKey: string): Promise<RecallResult> {
    if (!query || !sessionKey) {
      throw new MemoryAdapterError("recall requires `query` and `sessionKey`", {
        code: "BAD_ARGS",
      });
    }
    const body = {
      query,
      session_key: sessionKey,
      ...(this.defaultUserId ? { user_id: this.defaultUserId } : {}),
    };
    const res = await this.postJson<GatewayRecallResponse>("/recall", body);
    // The Gateway returns only `context` (= appendSystemContext). prependContext
    // is not exposed over HTTP today; see gateway/server.ts handleRecall.
    return {
      appendSystemContext: res.context,
      recallStrategy: res.strategy,
      recalledL1Memories: [],
    };
  }

  async capture(turn: CaptureTurn): Promise<CaptureResult> {
    if (!turn || !turn.sessionKey) {
      throw new MemoryAdapterError("capture requires `sessionKey`", {
        code: "BAD_ARGS",
      });
    }
    const body = {
      user_content: turn.userText ?? "",
      assistant_content: turn.assistantText ?? "",
      session_key: turn.sessionKey,
      ...(turn.sessionId ? { session_id: turn.sessionId } : {}),
      ...(this.defaultUserId ? { user_id: this.defaultUserId } : {}),
      ...(turn.messages ? { messages: turn.messages } : {}),
    };
    const res = await this.postJson<GatewayCaptureResponse>("/capture", body);
    return {
      l0RecordedCount: res.l0_recorded,
      schedulerNotified: res.scheduler_notified,
      l0VectorsWritten: 0,
      filteredMessages: [],
    };
  }

  async searchMemories(params: MemorySearchParams): Promise<MemorySearchOutcome> {
    if (!params || !params.query) {
      throw new MemoryAdapterError("searchMemories requires `query`", {
        code: "BAD_ARGS",
      });
    }
    const res = await this.postJson<GatewayMemorySearchResponse>("/search/memories", {
      query: params.query,
      ...(params.limit != null ? { limit: params.limit } : {}),
      ...(params.type ? { type: params.type } : {}),
      ...(params.scene ? { scene: params.scene } : {}),
    });
    return { text: res.results, total: res.total, strategy: res.strategy };
  }

  async searchConversations(
    params: ConversationSearchParams,
  ): Promise<ConversationSearchOutcome> {
    if (!params || !params.query) {
      throw new MemoryAdapterError("searchConversations requires `query`", {
        code: "BAD_ARGS",
      });
    }
    const res = await this.postJson<GatewayConversationSearchResponse>(
      "/search/conversations",
      {
        query: params.query,
        ...(params.limit != null ? { limit: params.limit } : {}),
        ...(params.sessionKey ? { session_key: params.sessionKey } : {}),
      },
    );
    return { text: res.results, total: res.total };
  }

  async endSession(sessionKey: string): Promise<void> {
    if (!sessionKey) return;
    await this.postJson<GatewaySessionEndResponse>("/session/end", {
      session_key: sessionKey,
      ...(this.defaultUserId ? { user_id: this.defaultUserId } : {}),
    });
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const res = await this.getJson<GatewayHealthResponse>("/health");
      return {
        ok: res.status === "ok",
        detail: {
          status: res.status,
          version: res.version,
          stores: res.stores,
        },
      };
    } catch (err) {
      return {
        ok: false,
        detail: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  // ── internals ───────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) h["authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...this.headers(), ...(init.headers ?? {}) },
        signal: init.signal ?? controller.signal,
      });
      if (!resp.ok) {
        let detail = "";
        try {
          detail = JSON.stringify(await resp.json());
        } catch {
          /* ignore body parse error */
        }
        throw new MemoryAdapterError(
          `Gateway ${path} returned ${resp.status} ${resp.statusText}${detail ? `: ${detail}` : ""}`,
          { code: "HTTP_ERROR", status: resp.status },
        );
      }
      return (await resp.json()) as T;
    } catch (err) {
      if (err instanceof MemoryAdapterError) throw err;
      const aborted = err instanceof Error && err.name === "AbortError";
      throw new MemoryAdapterError(
        `Gateway ${path} ${aborted ? "timed out" : "failed"}: ${err instanceof Error ? err.message : String(err)}`,
        { code: aborted ? "TIMEOUT" : "NETWORK_ERROR", cause: err },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private postJson<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  private getJson<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }
}
