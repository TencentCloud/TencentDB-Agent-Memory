import {
  GatewayConfigurationError,
  GatewayHttpError,
  GatewayResponseError,
  GatewayTimeoutError,
  GatewayTransportError,
} from "./errors.js";
import type {
  GatewayCaptureInput,
  GatewayCaptureResponse,
  GatewayConversationSearchInput,
  GatewayConversationSearchResponse,
  GatewayHealthResponse,
  GatewayMemoryClientOptions,
  GatewayMemorySearchInput,
  GatewayMemorySearchResponse,
  GatewayRecallInput,
  GatewayRecallResponse,
  GatewaySessionEndInput,
  GatewaySessionEndResponse,
} from "./types.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:8420";
const DEFAULT_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isHealthResponse(value: unknown): value is GatewayHealthResponse {
  if (!isRecord(value) || !isRecord(value.stores)) return false;
  return (value.status === "ok" || value.status === "degraded")
    && typeof value.version === "string"
    && isFiniteNumber(value.uptime)
    && typeof value.stores.vectorStore === "boolean"
    && typeof value.stores.embeddingService === "boolean";
}

function isRecallResponse(value: unknown): value is GatewayRecallResponse {
  return isRecord(value)
    && typeof value.context === "string"
    && (value.strategy === undefined || typeof value.strategy === "string")
    && (value.memory_count === undefined || isFiniteNumber(value.memory_count));
}

function isCaptureResponse(value: unknown): value is GatewayCaptureResponse {
  return isRecord(value)
    && isFiniteNumber(value.l0_recorded)
    && typeof value.scheduler_notified === "boolean";
}

function isMemorySearchResponse(value: unknown): value is GatewayMemorySearchResponse {
  return isRecord(value)
    && typeof value.results === "string"
    && isFiniteNumber(value.total)
    && typeof value.strategy === "string";
}

function isConversationSearchResponse(
  value: unknown,
): value is GatewayConversationSearchResponse {
  return isRecord(value)
    && typeof value.results === "string"
    && isFiniteNumber(value.total);
}

function isSessionEndResponse(value: unknown): value is GatewaySessionEndResponse {
  return isRecord(value) && typeof value.flushed === "boolean";
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || normalized === "127.0.0.1";
}

function normalizeBaseUrl(raw: string, allowRemote: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (cause) {
    throw new GatewayConfigurationError(`Invalid Gateway base URL: ${raw}`, { cause });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new GatewayConfigurationError("Gateway base URL must use http: or https:");
  }
  if (parsed.username || parsed.password) {
    throw new GatewayConfigurationError("Gateway base URL must not contain credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new GatewayConfigurationError("Gateway base URL must not contain a query or fragment");
  }
  if (!allowRemote && !isLoopbackHostname(parsed.hostname)) {
    throw new GatewayConfigurationError(
      `Remote Gateway host "${parsed.hostname}" requires allowRemote: true`,
    );
  }
  return parsed.toString().replace(/\/+$/, "");
}

function requireText(value: string, field: string): string {
  const text = value?.trim();
  if (!text) throw new GatewayConfigurationError(`${field} must be a non-empty string`);
  return text;
}

export class GatewayMemoryClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: GatewayMemoryClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ?? DEFAULT_BASE_URL,
      options.allowRemote ?? false,
    );
    this.apiKey = options.apiKey?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new GatewayConfigurationError("timeoutMs must be a positive finite number");
    }
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new GatewayConfigurationError("A fetch implementation is required");
    }
    this.fetchImpl = fetchImpl.bind(globalThis);
  }

  health(): Promise<GatewayHealthResponse> {
    return this.request("GET", "/health", undefined, isHealthResponse);
  }

  recall(input: GatewayRecallInput): Promise<GatewayRecallResponse> {
    return this.request("POST", "/recall", {
      query: requireText(input.query, "query"),
      session_key: requireText(input.sessionKey, "sessionKey"),
      ...(input.userId ? { user_id: input.userId } : {}),
    }, isRecallResponse);
  }

  capture(input: GatewayCaptureInput): Promise<GatewayCaptureResponse> {
    return this.request("POST", "/capture", {
      user_content: requireText(input.userContent, "userContent"),
      assistant_content: requireText(input.assistantContent, "assistantContent"),
      session_key: requireText(input.sessionKey, "sessionKey"),
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      ...(input.userId ? { user_id: input.userId } : {}),
      ...(input.messages ? { messages: input.messages } : {}),
    }, isCaptureResponse);
  }

  searchMemories(input: GatewayMemorySearchInput): Promise<GatewayMemorySearchResponse> {
    return this.request("POST", "/search/memories", {
      query: requireText(input.query, "query"),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.type ? { type: input.type } : {}),
      ...(input.scene ? { scene: input.scene } : {}),
    }, isMemorySearchResponse);
  }

  searchConversations(
    input: GatewayConversationSearchInput,
  ): Promise<GatewayConversationSearchResponse> {
    return this.request("POST", "/search/conversations", {
      query: requireText(input.query, "query"),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.sessionKey ? { session_key: input.sessionKey } : {}),
    }, isConversationSearchResponse);
  }

  endSession(input: GatewaySessionEndInput): Promise<GatewaySessionEndResponse> {
    return this.request("POST", "/session/end", {
      session_key: requireText(input.sessionKey, "sessionKey"),
      ...(input.userId ? { user_id: input.userId } : {}),
    }, isSessionEndResponse);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    validate?: (value: unknown) => value is T,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (cause) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        throw new GatewayTimeoutError(url, this.timeoutMs, cause);
      }
      throw new GatewayTransportError(url, cause);
    }

    let responseBody: string;
    try {
      responseBody = await response.text();
    } catch (cause) {
      if (controller.signal.aborted) {
        throw new GatewayTimeoutError(url, this.timeoutMs, cause);
      }
      throw new GatewayTransportError(url, cause);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new GatewayHttpError(url, response.status, responseBody);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(responseBody);
    } catch (cause) {
      throw new GatewayResponseError(url, responseBody, cause, "malformed JSON");
    }
    if (!isRecord(parsed)) {
      throw new GatewayResponseError(url, responseBody, undefined, "expected JSON object");
    }
    if (validate && !validate(parsed)) {
      throw new GatewayResponseError(url, responseBody, undefined, "unexpected schema");
    }
    return parsed as T;
  }
}
