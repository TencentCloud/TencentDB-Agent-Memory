/**
 * TDAI Gateway HTTP client for the Pi coding agent extension.
 *
 * A minimal, dependency-free typed client for the subset of Gateway
 * endpoints the Pi adapter needs:
 *
 *   POST /recall               — memory recall before each agent run
 *   POST /capture              — conversation capture after each agent run
 *   POST /search/memories      — explicit L1 memory search (agent tool)
 *   POST /session/end          — session end + flush
 *
 * Design:
 * - Every method is **fault-tolerant**: network errors, timeouts, and
 *   non-2xx responses resolve to `null` instead of throwing, so the host
 *   agent never breaks when the Gateway is down. Callers decide how to
 *   degrade (skip injection, skip capture, report tool error).
 * - Auth: when `apiKey` is set, requests carry `Authorization: Bearer <key>`
 *   (matching `TDAI_GATEWAY_API_KEY` on the Gateway side).
 * - Timeouts use `AbortSignal.timeout()` per call; an optional outer signal
 *   (e.g. Pi's `ctx.signal`) is combined via `AbortSignal.any()` so Esc can
 *   cancel in-flight recalls.
 */

// ============================
// Request/response types (mirrors src/gateway/types.ts)
// ============================

export interface RecallResult {
  context: string;
  strategy?: string;
  memory_count?: number;
}

export interface CaptureResult {
  l0_recorded: number;
  scheduler_notified: boolean;
}

export interface MemorySearchResult {
  results: string;
  total: number;
  strategy: string;
}

export interface SessionEndResult {
  flushed: boolean;
}

export interface GatewayClientOptions {
  /** Gateway base URL, e.g. "http://127.0.0.1:8420" (no trailing slash needed). */
  baseUrl: string;
  /** Optional Bearer token (must match the Gateway's TDAI_GATEWAY_API_KEY). */
  apiKey?: string;
  /** Per-request timeout in milliseconds (default: 5000). */
  timeoutMs?: number;
  /** Optional error sink for diagnostics (e.g. Pi status line). */
  onError?: (operation: string, error: unknown) => void;
}

// ============================
// Client
// ============================

export class GatewayClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly onError?: (operation: string, error: unknown) => void;

  constructor(options: GatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.onError = options.onError;
  }

  /** Recall memories relevant to `query`. Returns null on any failure. */
  async recall(
    query: string,
    sessionKey: string,
    signal?: AbortSignal,
  ): Promise<RecallResult | null> {
    return this.post<RecallResult>(
      "/recall",
      { query, session_key: sessionKey },
      signal,
    );
  }

  /** Capture one user/assistant round. Returns null on any failure. */
  async capture(
    userContent: string,
    assistantContent: string,
    sessionKey: string,
    signal?: AbortSignal,
  ): Promise<CaptureResult | null> {
    return this.post<CaptureResult>(
      "/capture",
      {
        user_content: userContent,
        assistant_content: assistantContent,
        session_key: sessionKey,
      },
      signal,
    );
  }

  /** Explicit L1 memory search. Returns null on any failure. */
  async searchMemories(
    query: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<MemorySearchResult | null> {
    return this.post<MemorySearchResult>(
      "/search/memories",
      limit === undefined ? { query } : { query, limit },
      signal,
    );
  }

  /** Notify the Gateway that a session ended (flush pending pipeline work). */
  async sessionEnd(
    sessionKey: string,
    signal?: AbortSignal,
  ): Promise<SessionEndResult | null> {
    return this.post<SessionEndResult>(
      "/session/end",
      { session_key: sessionKey },
      signal,
    );
  }

  // ============================
  // Internals
  // ============================

  private async post<T>(
    path: string,
    body: unknown,
    outerSignal?: AbortSignal,
  ): Promise<T | null> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = outerSignal
      ? AbortSignal.any([outerSignal, timeoutSignal])
      : timeoutSignal;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) {
        this.onError?.(path, new Error(`HTTP ${response.status}`));
        return null;
      }
      return (await response.json()) as T;
    } catch (error) {
      this.onError?.(path, error);
      return null;
    }
  }
}
