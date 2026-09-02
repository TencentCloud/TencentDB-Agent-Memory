import {
  GatewayConfigurationError,
  GatewayHttpError,
  GatewayParseError,
  GatewayRedirectError,
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

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isHealthResponse(value: unknown): value is GatewayHealthResponse {
  if (!isRecord(value) || !isRecord(value.stores)) return false;
  return (value.status === "ok" || value.status === "degraded")
    && typeof value.version === "string"
    && isNonNegativeInteger(value.uptime)
    && typeof value.stores.vectorStore === "boolean"
    && typeof value.stores.embeddingService === "boolean";
}

function isRecallResponse(value: unknown): value is GatewayRecallResponse {
  return isRecord(value)
    && typeof value.context === "string"
    && (value.prepend_context === undefined || typeof value.prepend_context === "string")
    && (
      value.append_system_context === undefined
      || typeof value.append_system_context === "string"
    )
    && (value.strategy === undefined || typeof value.strategy === "string")
    && (
      value.memory_count === undefined
      || isNonNegativeInteger(value.memory_count)
    );
}

function isCaptureResponse(value: unknown): value is GatewayCaptureResponse {
  return isRecord(value)
    && isNonNegativeInteger(value.l0_recorded)
    && typeof value.scheduler_notified === "boolean";
}

function isMemorySearchResponse(value: unknown): value is GatewayMemorySearchResponse {
  return isRecord(value)
    && typeof value.results === "string"
    && isNonNegativeInteger(value.total)
    && typeof value.strategy === "string";
}

function isConversationSearchResponse(
  value: unknown,
): value is GatewayConversationSearchResponse {
  return isRecord(value)
    && typeof value.results === "string"
    && isNonNegativeInteger(value.total);
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

function optionalText(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : requireText(value, field);
}

function optionalLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) {
    throw new GatewayConfigurationError("limit must be an integer between 1 and 50");
  }
  return value;
}

function normalizeMessages(
  messages: GatewayCaptureInput["messages"],
): GatewayCaptureInput["messages"] {
  if (messages === undefined) return undefined;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new GatewayConfigurationError("messages must be a non-empty array when provided");
  }
  return messages.map((message, index) => {
    if (!isRecord(message)) {
      throw new GatewayConfigurationError(`messages[${index}] must be an object`);
    }
    const role = requireText(message.role, `messages[${index}].role`);
    const content = requireText(message.content, `messages[${index}].content`);
    if (
      message.timestamp !== undefined
      && (!Number.isSafeInteger(message.timestamp) || message.timestamp <= 0)
    ) {
      throw new GatewayConfigurationError(
        `messages[${index}].timestamp must be a positive safe integer`,
      );
    }
    return { ...message, role, content };
  });
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
    const userId = optionalText(input.userId, "userId");
    return this.request("POST", "/recall", {
      query: requireText(input.query, "query"),
      session_key: requireText(input.sessionKey, "sessionKey"),
      ...(userId ? { user_id: userId } : {}),
    }, isRecallResponse);
  }

  capture(input: GatewayCaptureInput): Promise<GatewayCaptureResponse> {
    const sessionId = optionalText(input.sessionId, "sessionId");
    const userId = optionalText(input.userId, "userId");
    const messages = normalizeMessages(input.messages);
    return this.request("POST", "/capture", {
      user_content: requireText(input.userContent, "userContent"),
      assistant_content: requireText(input.assistantContent, "assistantContent"),
      session_key: requireText(input.sessionKey, "sessionKey"),
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(userId ? { user_id: userId } : {}),
      ...(messages ? { messages } : {}),
    }, isCaptureResponse);
  }

  searchMemories(input: GatewayMemorySearchInput): Promise<GatewayMemorySearchResponse> {
    const limit = optionalLimit(input.limit);
    const type = optionalText(input.type, "type");
    const scene = optionalText(input.scene, "scene");
    return this.request("POST", "/search/memories", {
      query: requireText(input.query, "query"),
      ...(limit !== undefined ? { limit } : {}),
      ...(type ? { type } : {}),
      ...(scene ? { scene } : {}),
    }, isMemorySearchResponse);
  }

  searchConversations(
    input: GatewayConversationSearchInput,
  ): Promise<GatewayConversationSearchResponse> {
    const limit = optionalLimit(input.limit);
    const sessionKey = optionalText(input.sessionKey, "sessionKey");
    return this.request("POST", "/search/conversations", {
      query: requireText(input.query, "query"),
      ...(limit !== undefined ? { limit } : {}),
      ...(sessionKey ? { session_key: sessionKey } : {}),
    }, isConversationSearchResponse);
  }

  endSession(input: GatewaySessionEndInput): Promise<GatewaySessionEndResponse> {
    const userId = optionalText(input.userId, "userId");
    return this.request("POST", "/session/end", {
      session_key: requireText(input.sessionKey, "sessionKey"),
      ...(userId ? { user_id: userId } : {}),
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

    let encodedBody: string | undefined;
    try {
      encodedBody = body === undefined ? undefined : JSON.stringify(body);
    } catch (cause) {
      clearTimeout(timer);
      throw new GatewayConfigurationError("Gateway request body must be JSON-serializable", {
        cause,
      });
    }

    let response: Response;
    try {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: encodedBody,
        signal: controller.signal,
        // Never let fetch forward a request or Bearer token to a Location that
        // has not passed the constructor's loopback/remote policy.
        redirect: "manual",
      });
    } catch (cause) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        throw new GatewayTimeoutError(url, this.timeoutMs, cause);
      }
      throw new GatewayTransportError(url, cause);
    }

    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      clearTimeout(timer);
      throw new GatewayRedirectError(
        url,
        response.status,
        (response.headers.get("location") ?? response.url) || undefined,
      );
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
      throw new GatewayParseError(url, responseBody, cause);
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
