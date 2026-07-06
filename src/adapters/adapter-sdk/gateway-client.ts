import type {
  CaptureInput,
  CaptureResult,
  ConversationSearchInput,
  ConversationSearchResult,
  GatewayClientOptions,
  GatewayHealth,
  MemorySearchInput,
  MemorySearchResult,
  RecallInput,
  RecallResult,
} from "./types.js";

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8420";
const DEFAULT_TIMEOUT_MS = 10_000;

export class GatewayClient {
  readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GatewayClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.TDAI_GATEWAY_URL ?? DEFAULT_GATEWAY_URL).replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? process.env.TDAI_GATEWAY_API_KEY;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async health(timeoutMs = 2_000): Promise<GatewayHealth | null> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;
      return (await response.json()) as GatewayHealth;
    } catch {
      return null;
    }
  }

  async isHealthy(timeoutMs = 2_000): Promise<boolean> {
    const health = await this.health(timeoutMs);
    return health?.status === "ok" || health?.status === "degraded";
  }

  async recall(input: RecallInput): Promise<RecallResult> {
    return this.post<RecallResult>("/recall", input);
  }

  async capture(input: CaptureInput, timeoutMs = this.timeoutMs): Promise<CaptureResult> {
    const response = await this.post<Omit<CaptureResult, "ok">>("/capture", input, timeoutMs);
    return { ...response, ok: true };
  }

  async searchMemories(input: MemorySearchInput): Promise<MemorySearchResult> {
    return this.post<MemorySearchResult>("/search/memories", input);
  }

  async searchConversations(input: ConversationSearchInput): Promise<ConversationSearchResult> {
    return this.post<ConversationSearchResult>("/search/conversations", input);
  }

  private async post<T>(path: string, body: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = typeof payload?.error === "string" ? payload.error : `Gateway request failed: ${response.status}`;
      throw new Error(message);
    }
    return payload as T;
  }
}
