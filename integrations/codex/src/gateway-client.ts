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
  SeedRequest,
  SeedResponse,
  SessionEndRequest,
  SessionEndResponse,
} from "./types.js";

export interface GatewayClientOptions {
  baseUrl: string;
  timeoutMs: number;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export class GatewayClientError extends Error {
  constructor(
    message: string,
    readonly route: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GatewayClientError";
  }
}

export class GatewayClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GatewayClientOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs;
    this.apiKey = options.apiKey?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  health(timeoutMs = Math.min(this.timeoutMs, 3_000)): Promise<HealthResponse> {
    return this.request<HealthResponse>("/health", "GET", undefined, timeoutMs);
  }

  recall(body: RecallRequest): Promise<RecallResponse> {
    return this.request("/recall", "POST", body);
  }

  capture(body: CaptureRequest): Promise<CaptureResponse> {
    return this.request("/capture", "POST", body);
  }

  searchMemories(body: MemorySearchRequest): Promise<MemorySearchResponse> {
    return this.request("/search/memories", "POST", body);
  }

  searchConversations(body: ConversationSearchRequest): Promise<ConversationSearchResponse> {
    return this.request("/search/conversations", "POST", body);
  }

  sessionEnd(body: SessionEndRequest): Promise<SessionEndResponse> {
    return this.request("/session/end", "POST", body);
  }

  seed(body: SeedRequest): Promise<SeedResponse> {
    return this.request("/seed", "POST", body, Math.max(this.timeoutMs, 300_000));
  }

  private async request<T>(route: string, method: "GET" | "POST", body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const headers: Record<string, string> = {};
    if (method === "POST") headers["Content-Type"] = "application/json";
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${route}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new GatewayClientError(`Gateway request failed for ${route}: ${detail}`, route);
    }

    const responseText = await response.text();
    if (!response.ok) {
      throw new GatewayClientError(
        `Gateway ${route} returned HTTP ${response.status}: ${responseText.slice(0, 500)}`,
        route,
        response.status,
      );
    }

    try {
      return JSON.parse(responseText) as T;
    } catch {
      throw new GatewayClientError(`Gateway ${route} returned invalid JSON.`, route, response.status);
    }
  }
}
