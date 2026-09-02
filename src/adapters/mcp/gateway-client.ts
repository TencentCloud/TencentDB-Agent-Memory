import type {
  CaptureRequest,
  CaptureResponse,
  ConversationSearchRequest,
  ConversationSearchResponse,
  MemorySearchRequest,
  MemorySearchResponse,
  RecallRequest,
  RecallResponse,
  SessionEndRequest,
  SessionEndResponse,
} from "../../gateway/types.js";

export interface GatewayClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class GatewayRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "GatewayRequestError";
  }
}

export class TdaiGatewayClient {
  private readonly baseUrl: URL;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GatewayClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey?.trim() || undefined;
    this.timeoutMs = normalizeTimeout(options.timeoutMs);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  recall(request: RecallRequest): Promise<RecallResponse> {
    return this.post("recall", request);
  }

  capture(request: CaptureRequest): Promise<CaptureResponse> {
    return this.post("capture", request);
  }

  searchMemories(request: MemorySearchRequest): Promise<MemorySearchResponse> {
    return this.post("search/memories", request);
  }

  searchConversations(
    request: ConversationSearchRequest,
  ): Promise<ConversationSearchResponse> {
    return this.post("search/conversations", request);
  }

  endSession(request: SessionEndRequest): Promise<SessionEndResponse> {
    return this.post("session/end", request);
  }

  private async post<T>(route: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(new URL(route, this.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) {
        const error = asRecord(payload);
        throw new GatewayRequestError(
          typeof error?.error === "string"
            ? error.error
            : `Gateway request failed with HTTP ${response.status}`,
          response.status,
          typeof error?.code === "string" ? error.code : undefined,
        );
      }
      if (!asRecord(payload)) {
        throw new GatewayRequestError(
          `Gateway returned a non-object JSON response with HTTP ${response.status}`,
          response.status,
        );
      }
      return payload as T;
    } catch (error) {
      if (error instanceof GatewayRequestError) throw error;
      if (controller.signal.aborted) {
        throw new GatewayRequestError(`Gateway request timed out after ${this.timeoutMs}ms`);
      }
      throw new GatewayRequestError(
        `Gateway request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid TDAI Gateway URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("TDAI Gateway URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("TDAI Gateway URL must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new Error("TDAI Gateway URL must not contain a query or fragment");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function normalizeTimeout(value: number | undefined): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : 10_000;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GatewayRequestError(
      `Gateway returned invalid JSON with HTTP ${response.status}`,
      response.status,
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
