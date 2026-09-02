import type {
  ConversationSearchRequest,
  ConversationSearchResponse,
  GatewayClientOptions,
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

export class TdaiGatewayClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "TdaiGatewayClientError";
  }
}

export class TdaiGatewayClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/health");
  }

  recall(body: RecallRequest): Promise<RecallResponse> {
    return this.request<RecallResponse>("POST", "/recall", body);
  }

  searchMemories(body: MemorySearchRequest): Promise<MemorySearchResponse> {
    return this.request<MemorySearchResponse>("POST", "/search/memories", body);
  }

  searchConversations(body: ConversationSearchRequest): Promise<ConversationSearchResponse> {
    return this.request<ConversationSearchResponse>("POST", "/search/conversations", body);
  }

  seed(body: SeedRequest): Promise<SeedResponse> {
    return this.request<SeedResponse>("POST", "/seed", body);
  }

  sessionEnd(body: SessionEndRequest): Promise<SessionEndResponse> {
    return this.request<SessionEndResponse>("POST", "/session/end", body);
  }

  private async request<T>(method: "GET" | "POST", endpoint: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new TdaiGatewayClientError(
        `TDAI Gateway ${method} ${endpoint} failed with HTTP ${response.status}`,
        response.status,
        text,
      );
    }

    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch (err) {
      throw new TdaiGatewayClientError(
        `TDAI Gateway ${method} ${endpoint} returned invalid JSON`,
        response.status,
        text,
      );
    }
  }
}
