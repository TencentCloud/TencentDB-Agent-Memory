/**
 * Thin HTTP client for the TDAI Gateway (Kimi Code CLI adapter).
 *
 * This is intentionally not a TdaiCore integration: the Kimi MCP server talks
 * to the already-running gateway over HTTP, reusing the same request/response
 * types. The gateway default URL is `http://127.0.0.1:8420`.
 */

import type {
  RecallRequest,
  RecallResponse,
  CaptureRequest,
  CaptureResponse,
  MemorySearchRequest,
  MemorySearchResponse,
  ConversationSearchRequest,
  ConversationSearchResponse,
  SessionEndRequest,
  SessionEndResponse,
  GatewayErrorResponse,
} from "../../gateway/types.js";

export interface KimiCodeGatewayClientOptions {
  /**
   * Gateway base URL, e.g. `http://127.0.0.1:8420`.
   * Defaults to `http://127.0.0.1:8420`.
   */
  baseUrl?: string;
  /** Optional Bearer token sent as `Authorization: Bearer <token>`. */
  apiKey?: string;
  /** Request timeout in milliseconds (default: 10_000). */
  timeoutMs?: number;
  /** Custom fetch implementation (useful for tests). Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
}

/** Error thrown when the gateway responds with a non-2xx status or cannot be reached. */
export class GatewayClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly response?: GatewayErrorResponse,
  ) {
    super(message);
    this.name = "GatewayClientError";
  }
}

/** Normalize a base URL so it has no trailing slash. */
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Default TDAI Gateway URL used by the standalone gateway. */
export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8420";

export class KimiCodeGatewayClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: KimiCodeGatewayClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_GATEWAY_URL);
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private async post<Req, Res>(path: string, body: Req): Promise<Res> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === "AbortError") {
        throw new GatewayClientError(
          `Gateway request timed out after ${this.timeoutMs}ms`,
          0,
        );
      }
      throw new GatewayClientError(
        err instanceof Error ? err.message : String(err),
        0,
      );
    }
    clearTimeout(timeout);

    let data: unknown;
    const text = await response.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }

    if (!response.ok) {
      const errorBody =
        data && typeof data === "object" && "error" in data
          ? (data as GatewayErrorResponse)
          : undefined;
      throw new GatewayClientError(
        errorBody?.error ?? `Gateway returned ${response.status}`,
        response.status,
        errorBody,
      );
    }

    return data as Res;
  }

  async recall(request: RecallRequest): Promise<RecallResponse> {
    return this.post<RecallRequest, RecallResponse>("/recall", request);
  }

  async capture(request: CaptureRequest): Promise<CaptureResponse> {
    return this.post<CaptureRequest, CaptureResponse>("/capture", request);
  }

  async searchMemories(request: MemorySearchRequest): Promise<MemorySearchResponse> {
    return this.post<MemorySearchRequest, MemorySearchResponse>("/search/memories", request);
  }

  async searchConversations(
    request: ConversationSearchRequest,
  ): Promise<ConversationSearchResponse> {
    return this.post<ConversationSearchRequest, ConversationSearchResponse>(
      "/search/conversations",
      request,
    );
  }

  async endSession(request: SessionEndRequest): Promise<SessionEndResponse> {
    return this.post<SessionEndRequest, SessionEndResponse>("/session/end", request);
  }
}
