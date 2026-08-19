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

export interface GatewayClientOptions {
  baseUrl: string;
  timeoutMs: number;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validResponse(route: string, value: unknown): boolean {
  if (!isRecord(value)) return false;
  const string = (key: string): boolean => typeof value[key] === "string";
  const number = (key: string): boolean => typeof value[key] === "number";
  const boolean = (key: string): boolean => typeof value[key] === "boolean";

  switch (route) {
    case "/health": {
      const stores = value.stores;
      return (
        (value.status === "ok" || value.status === "degraded") &&
        string("version") &&
        number("uptime") &&
        isRecord(stores) &&
        typeof stores.vectorStore === "boolean" &&
        typeof stores.embeddingService === "boolean"
      );
    }
    case "/recall":
      return string("context");
    case "/capture":
      return number("l0_recorded") && boolean("scheduler_notified");
    case "/search/memories":
      return string("results") && number("total") && string("strategy");
    case "/search/conversations":
      return string("results") && number("total");
    case "/session/end":
      return boolean("flushed");
    case "/seed":
      return (
        number("sessions_processed") &&
        number("rounds_processed") &&
        number("messages_processed") &&
        number("l0_recorded") &&
        number("duration_ms") &&
        string("output_dir")
      );
    default:
      return false;
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
    return this.request("/health", "GET", undefined, timeoutMs);
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

  searchConversations(
    body: ConversationSearchRequest,
  ): Promise<ConversationSearchResponse> {
    return this.request("/search/conversations", "POST", body);
  }

  sessionEnd(body: SessionEndRequest): Promise<SessionEndResponse> {
    return this.request("/session/end", "POST", body);
  }

  seed(body: SeedRequest): Promise<SeedResponse> {
    return this.request(
      "/seed",
      "POST",
      body,
      Math.max(this.timeoutMs, 300_000),
    );
  }

  private async request<T>(
    route: string,
    method: "GET" | "POST",
    body?: unknown,
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
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
      const reason = error instanceof Error ? error.message : String(error);
      throw new GatewayClientError(
        `Gateway request failed for ${route}: ${reason}`,
        route,
      );
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
      const parsed: unknown = JSON.parse(responseText);
      if (!validResponse(route, parsed)) {
        throw new GatewayClientError(
          `Gateway ${route} returned an invalid response shape.`,
          route,
          response.status,
        );
      }
      return parsed as T;
    } catch {
      if (
        responseText.trim().startsWith("{") ||
        responseText.trim().startsWith("[")
      ) {
        throw new GatewayClientError(
          `Gateway ${route} returned an invalid response shape.`,
          route,
          response.status,
        );
      }
      throw new GatewayClientError(
        `Gateway ${route} returned invalid JSON.`,
        route,
        response.status,
      );
    }
  }
}
