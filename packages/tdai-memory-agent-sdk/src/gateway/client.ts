import type {
  CaptureRequest,
  CaptureResponse,
  ConversationSearchRequest,
  ConversationSearchResponse,
  GatewayClientLike,
  JsonRecord,
  MemorySearchRequest,
  MemorySearchResponse,
  RecallRequest,
  RecallResponse,
  SessionEndRequest,
  SessionEndResponse,
} from "../types.js";

export class GatewayHttpError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: unknown;

  constructor(message: string, options: { status?: number; path?: string; body?: unknown } = {}) {
    super(message);
    this.name = "GatewayHttpError";
    this.status = options.status ?? 0;
    this.path = options.path ?? "";
    this.body = options.body;
  }
}

export interface GatewayClientOptions {
  gatewayUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class GatewayClient implements GatewayClientLike {
  private readonly gatewayUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GatewayClientOptions) {
    this.gatewayUrl = options.gatewayUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey?.trim() ?? "";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  health(): Promise<JsonRecord> {
    return this.request<JsonRecord>("/health", { method: "GET" });
  }

  async recall(request: RecallRequest): Promise<RecallResponse> {
    const response = await this.request<{ context: string; strategy?: string; memory_count?: number }>("/recall", {
      body: omitUndefined({
        query: request.query,
        session_key: request.sessionKey,
        user_id: request.userId,
      }),
    });
    return {
      context: response.context ?? "",
      strategy: response.strategy,
      memoryCount: response.memory_count,
    };
  }

  async capture(request: CaptureRequest): Promise<CaptureResponse> {
    const response = await this.request<{ l0_recorded: number; scheduler_notified: boolean }>("/capture", {
      body: omitUndefined({
        user_content: request.userContent,
        assistant_content: request.assistantContent,
        session_key: request.sessionKey,
        session_id: request.sessionId,
        user_id: request.userId,
        started_at: request.startedAt,
        messages: request.messages,
      }),
    });
    return {
      l0Recorded: response.l0_recorded,
      schedulerNotified: response.scheduler_notified,
    };
  }

  async endSession(request: SessionEndRequest): Promise<SessionEndResponse> {
    const response = await this.request<{ flushed: boolean }>("/session/end", {
      body: omitUndefined({
        session_key: request.sessionKey,
        user_id: request.userId,
      }),
    });
    return { flushed: response.flushed };
  }

  searchMemories(request: MemorySearchRequest): Promise<MemorySearchResponse> {
    return this.request<MemorySearchResponse>("/search/memories", {
      body: omitUndefined({
        query: request.query,
        limit: request.limit,
        type: request.type,
        scene: request.scene,
      }),
    });
  }

  async searchConversations(request: ConversationSearchRequest): Promise<ConversationSearchResponse> {
    const response = await this.request<{ results: string; total: number }>("/search/conversations", {
      body: omitUndefined({
        query: request.query,
        limit: request.limit,
        session_key: request.sessionKey,
      }),
    });
    return {
      results: response.results,
      total: response.total,
    };
  }

  private async request<T>(
    path: string,
    options: { method?: "GET" | "POST"; body?: JsonRecord } = {},
  ): Promise<T> {
    const method = options.method ?? "POST";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {};
      let body: string | undefined;
      if (options.body) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(options.body);
      }
      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      const response = await this.fetchImpl(`${this.gatewayUrl}${path}`, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      const text = await response.text();
      const parsed = parseJson(text);

      if (!response.ok) {
        const message = isRecord(parsed) && typeof parsed.error === "string"
          ? parsed.error
          : `Gateway returned HTTP ${response.status}`;
        throw new GatewayHttpError(message, { status: response.status, path, body: parsed });
      }
      return (parsed ?? {}) as T;
    } catch (error) {
      if (error instanceof GatewayHttpError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new GatewayHttpError(`Gateway request timed out after ${this.timeoutMs}ms`, { path });
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new GatewayHttpError(message, { path });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function omitUndefined(input: JsonRecord): JsonRecord {
  const output: JsonRecord = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== "") output[key] = value;
  }
  return output;
}

function parseJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
