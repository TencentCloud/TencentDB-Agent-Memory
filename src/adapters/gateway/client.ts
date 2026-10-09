import type {
  CaptureInput,
  CaptureOutput,
  ConversationSearchInput,
  ConversationSearchOutput,
  EndSessionInput,
  EndSessionOutput,
  HealthResult,
  MemorySearchInput,
  MemorySearchOutput,
  MemoryService,
  RecallInput,
  RecallOutput,
} from "./types.js";
import type {
  CaptureResponse,
  ConversationSearchResponse,
  GatewayErrorResponse,
  MemorySearchResponse,
  RecallResponse,
  SessionEndResponse,
} from "../../gateway/types.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface GatewayMemoryClientOptions {
  /** Gateway root URL, for example http://127.0.0.1:8420. */
  baseUrl: string;
  /** Optional Bearer token matching TDAI_GATEWAY_API_KEY. */
  apiKey?: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Injectable fetch implementation for non-Node hosts and tests. */
  fetch?: typeof globalThis.fetch;
}

export class GatewayMemoryClientError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, options?: {
    status?: number;
    code?: string;
    cause?: unknown;
  }) {
    super(message, { cause: options?.cause });
    this.name = "GatewayMemoryClientError";
    this.status = options?.status;
    this.code = options?.code;
  }
}

/**
 * TypeScript SDK for the host-neutral TDAI Gateway API.
 *
 * The client performs only transport translation. Platform lifecycle and tool
 * semantics remain in the adapter that consumes the MemoryService interface.
 */
export class GatewayMemoryClient implements MemoryService {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: GatewayMemoryClientOptions) {
    const parsedUrl = new URL(options.baseUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new TypeError("Gateway baseUrl must use http or https");
    }
    if (parsedUrl.search || parsedUrl.hash) {
      throw new TypeError("Gateway baseUrl must not contain a query or fragment");
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("Gateway timeoutMs must be a positive integer");
    }

    this.baseUrl = parsedUrl.toString().replace(/\/+$/, "");
    this.apiKey = options.apiKey?.trim() || undefined;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  health(): Promise<HealthResult> {
    return this.request<HealthResult>("GET", "/health");
  }

  async recall(input: RecallInput): Promise<RecallOutput> {
    const response = await this.request<RecallResponse>("POST", "/recall", {
      query: input.query,
      session_key: input.sessionKey,
      ...(input.userId ? { user_id: input.userId } : {}),
    });
    return {
      context: response.context,
      strategy: response.strategy,
      memoryCount: response.memory_count,
    };
  }

  async capture(input: CaptureInput): Promise<CaptureOutput> {
    const response = await this.request<CaptureResponse>("POST", "/capture", {
      user_content: input.userContent,
      assistant_content: input.assistantContent,
      session_key: input.sessionKey,
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      ...(input.userId ? { user_id: input.userId } : {}),
      ...(input.messages ? { messages: input.messages } : {}),
    });
    return {
      l0Recorded: response.l0_recorded,
      schedulerNotified: response.scheduler_notified,
    };
  }

  async searchMemories(input: MemorySearchInput): Promise<MemorySearchOutput> {
    const response = await this.request<MemorySearchResponse>("POST", "/search/memories", {
      query: input.query,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.type ? { type: input.type } : {}),
      ...(input.scene ? { scene: input.scene } : {}),
    });
    return {
      results: response.results,
      total: response.total,
      strategy: response.strategy,
    };
  }

  async searchConversations(input: ConversationSearchInput): Promise<ConversationSearchOutput> {
    const response = await this.request<ConversationSearchResponse>("POST", "/search/conversations", {
      query: input.query,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.sessionKey ? { session_key: input.sessionKey } : {}),
    });
    return {
      results: response.results,
      total: response.total,
    };
  }

  async endSession(input: EndSessionInput): Promise<EndSessionOutput> {
    const response = await this.request<SessionEndResponse>("POST", "/session/end", {
      session_key: input.sessionKey,
      ...(input.userId ? { user_id: input.userId } : {}),
    });
    return { flushed: response.flushed };
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (body) headers["Content-Type"] = "application/json";
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const payload = await this.parseResponse(response);
      if (!response.ok) {
        const gatewayError = payload as GatewayErrorResponse;
        const detail = typeof gatewayError?.error === "string"
          ? gatewayError.error
          : response.statusText || "unknown error";
        throw new GatewayMemoryClientError(
          `Gateway request failed (${response.status}): ${detail}`,
          {
            status: response.status,
            code: gatewayError?.code,
          },
        );
      }
      return payload as T;
    } catch (error) {
      if (error instanceof GatewayMemoryClientError) throw error;
      const timedOut = controller.signal.aborted;
      const detail = timedOut
        ? `timed out after ${this.timeoutMs}ms`
        : error instanceof Error ? error.message : String(error);
      throw new GatewayMemoryClientError(`Gateway request failed: ${detail}`, {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async parseResponse(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new GatewayMemoryClientError(
        `Gateway returned invalid JSON (${response.status})`,
        {
          status: response.status,
          cause: error,
        },
      );
    }
  }
}
