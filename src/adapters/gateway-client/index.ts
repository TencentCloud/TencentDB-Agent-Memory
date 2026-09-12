/**
 * Gateway client adapter for non-OpenClaw platforms.
 *
 * Platforms such as Codex, Claude Code, Dify, or custom LangGraph agents can
 * integrate with memory-tencentdb without linking OpenClaw or Hermes SDKs by
 * calling the local TDAI Gateway over HTTP. This module provides a small,
 * dependency-free adapter around the Gateway API and a host-neutral helper for
 * wiring platform lifecycle hooks to recall/capture/search operations.
 */

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
  SessionEndRequest,
  SessionEndResponse,
} from "../../gateway/types.js";

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8420";

interface ResponseSchema<T> {
  parse(value: unknown): T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function responseSchema<T>(name: string, guard: (value: unknown) => value is T): ResponseSchema<T> {
  return {
    parse(value: unknown): T {
      if (!guard(value)) throw new TypeError(`Invalid ${name} response`);
      return value;
    },
  };
}

const healthResponseSchema = responseSchema<HealthResponse>("health", (value): value is HealthResponse =>
  isRecord(value)
  && (value.status === "ok" || value.status === "degraded")
  && typeof value.version === "string"
  && typeof value.uptime === "number"
  && isRecord(value.stores)
  && typeof value.stores.vectorStore === "boolean"
  && typeof value.stores.embeddingService === "boolean");

const recallResponseSchema = responseSchema<RecallResponse>("recall", (value): value is RecallResponse =>
  isRecord(value)
  && typeof value.context === "string"
  && (value.strategy === undefined || typeof value.strategy === "string")
  && (value.memory_count === undefined || isNonNegativeInteger(value.memory_count)));

const captureResponseSchema = responseSchema<CaptureResponse>("capture", (value): value is CaptureResponse =>
  isRecord(value)
  && isNonNegativeInteger(value.l0_recorded)
  && typeof value.scheduler_notified === "boolean");

const memorySearchResponseSchema = responseSchema<MemorySearchResponse>(
  "memory search",
  (value): value is MemorySearchResponse =>
    isRecord(value)
    && typeof value.results === "string"
    && isNonNegativeInteger(value.total)
    && typeof value.strategy === "string",
);

const conversationSearchResponseSchema = responseSchema<ConversationSearchResponse>(
  "conversation search",
  (value): value is ConversationSearchResponse =>
    isRecord(value) && typeof value.results === "string" && isNonNegativeInteger(value.total),
);

const sessionEndResponseSchema = responseSchema<SessionEndResponse>(
  "session end",
  (value): value is SessionEndResponse => isRecord(value) && typeof value.flushed === "boolean",
);

export interface GatewayMemoryClientOptions {
  /** Gateway base URL. Defaults to `http://127.0.0.1:8420`. */
  baseUrl?: string;
  /** Optional Bearer token when the Gateway is configured with an API key. */
  apiKey?: string;
  /** Per-request timeout in milliseconds. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Session flush timeout in milliseconds. Defaults to 120 seconds. */
  sessionEndTimeoutMs?: number;
  /** Explicitly allow a non-loopback Gateway URL. */
  allowRemote?: boolean;
  /** Test hook or platform-specific fetch implementation. */
  fetchImpl?: typeof fetch;
}

export interface GatewayPlatformContext {
  /** Stable conversation/session key used by TDAI for L0/L1 grouping. */
  sessionKey: string;
  /** Optional host-specific session id. */
  sessionId?: string;
  /** Optional user metadata. This does not create a Gateway isolation boundary. */
  userId?: string;
}

export interface GatewayPlatformAdapterOptions {
  client: GatewayMemoryClient;
  /** Host platform name used by callers for logging and diagnostics. */
  platform: string;
  /** Resolve the current session/user identity from the host runtime. */
  resolveContext: () => GatewayPlatformContext | Promise<GatewayPlatformContext>;
}

export interface GatewayPlatformAdapter {
  readonly platform: string;
  prefetch(query: string): Promise<RecallResponse>;
  captureTurn(turn: {
    userText: string;
    assistantText: string;
    messages?: unknown[];
  }): Promise<CaptureResponse>;
  searchMemories(params: MemorySearchRequest): Promise<MemorySearchResponse>;
  searchConversations(params: Omit<ConversationSearchRequest, "session_key"> & {
    sessionKey?: string;
  }): Promise<ConversationSearchResponse>;
  endSession(): Promise<SessionEndResponse>;
}

export class GatewayMemoryClientError extends Error {
  readonly status: number;
  readonly path: string;
  readonly responseBody: string;

  constructor(path: string, status: number, responseBody: string) {
    super(`Gateway request failed: ${path} returned ${status}`);
    this.name = "GatewayMemoryClientError";
    this.path = path;
    this.status = status;
    this.responseBody = responseBody;
  }
}

export class GatewayConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayConfigurationError";
  }
}

export class GatewayTransportError extends Error {
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(`Gateway request failed: ${url}`, { cause });
    this.name = "GatewayTransportError";
    this.url = url;
  }
}

export class GatewayTimeoutError extends GatewayTransportError {
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number, cause?: unknown) {
    super(url, cause);
    this.name = "GatewayTimeoutError";
    this.timeoutMs = timeoutMs;
    this.message = `Gateway request timed out after ${timeoutMs}ms: ${url}`;
  }
}

export class GatewayRedirectError extends Error {
  readonly url: string;
  readonly status?: number;
  readonly location?: string;

  constructor(url: string, status?: number, location?: string, cause?: unknown) {
    super(`Gateway redirect rejected${location ? ` to ${location}` : ""}: ${url}`, { cause });
    this.name = "GatewayRedirectError";
    this.url = url;
    this.status = status;
    this.location = location;
  }
}

export class GatewayResponseError extends Error {
  readonly url: string;
  readonly responseBody: string;

  constructor(url: string, responseBody: string, cause?: unknown) {
    super(`Gateway returned an invalid response: ${url}`, { cause });
    this.name = "GatewayResponseError";
    this.url = url;
    this.responseBody = responseBody;
  }
}

function normalizedGatewayUrl(baseUrl: string, allowRemote: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch (cause) {
    throw new GatewayConfigurationError(`Invalid Gateway URL: ${baseUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new GatewayConfigurationError("Gateway URL must use http: or https:");
  }
  if (parsed.username || parsed.password) {
    throw new GatewayConfigurationError("Gateway URL must not contain credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new GatewayConfigurationError("Gateway URL must not contain a query or fragment");
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (!loopback && !allowRemote) {
    throw new GatewayConfigurationError(
      "Remote Gateway URLs require allowRemote: true; prefer loopback or HTTPS with explicit opt-in",
    );
  }
  return parsed.toString().replace(/\/+$/, "");
}

export class GatewayMemoryClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly sessionEndTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GatewayMemoryClientOptions = {}) {
    this.baseUrl = normalizedGatewayUrl(opts.baseUrl ?? DEFAULT_GATEWAY_URL, opts.allowRemote ?? false);
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.sessionEndTimeoutMs = opts.sessionEndTimeoutMs ?? 120_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  health(): Promise<HealthResponse> {
    return this.request("GET", "/health", healthResponseSchema);
  }

  recall(body: RecallRequest): Promise<RecallResponse> {
    return this.request("POST", "/recall", recallResponseSchema, body);
  }

  capture(body: CaptureRequest): Promise<CaptureResponse> {
    return this.request("POST", "/capture", captureResponseSchema, body);
  }

  searchMemories(body: MemorySearchRequest): Promise<MemorySearchResponse> {
    return this.request("POST", "/search/memories", memorySearchResponseSchema, body);
  }

  searchConversations(body: ConversationSearchRequest): Promise<ConversationSearchResponse> {
    return this.request("POST", "/search/conversations", conversationSearchResponseSchema, body);
  }

  endSession(body: SessionEndRequest): Promise<SessionEndResponse> {
    return this.request(
      "POST",
      "/session/end",
      sessionEndResponseSchema,
      body,
      this.sessionEndTimeoutMs,
    );
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    schema: ResponseSchema<T>,
    body?: unknown,
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const url = `${this.baseUrl}${path}`;
    try {
      const headers: Record<string, string> = {};
      if (method === "POST") headers["Content-Type"] = "application/json";
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

      const response = await this.fetchImpl(url, {
        method,
        headers,
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        signal: controller.signal,
        redirect: "error",
      });
      const text = await response.text();

      if (response.status >= 300 && response.status < 400) {
        throw new GatewayRedirectError(url, response.status, response.headers.get("location") ?? undefined);
      }

      if (!response.ok) {
        throw new GatewayMemoryClientError(path, response.status, text);
      }
      try {
        return schema.parse(text ? JSON.parse(text) : {});
      } catch (cause) {
        throw new GatewayResponseError(url, text, cause);
      }
    } catch (error) {
      if (
        error instanceof GatewayMemoryClientError ||
        error instanceof GatewayRedirectError ||
        error instanceof GatewayResponseError
      ) {
        throw error;
      }
      if (controller.signal.aborted) throw new GatewayTimeoutError(url, timeoutMs, error);
      if (error instanceof TypeError && /redirect/i.test(error.message)) {
        throw new GatewayRedirectError(url, undefined, undefined, error);
      }
      throw new GatewayTransportError(url, error);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createGatewayPlatformAdapter(
  opts: GatewayPlatformAdapterOptions,
): GatewayPlatformAdapter {
  return {
    platform: opts.platform,

    async prefetch(query: string): Promise<RecallResponse> {
      const ctx = await opts.resolveContext();
      return opts.client.recall({
        query,
        session_key: ctx.sessionKey,
        user_id: ctx.userId,
      });
    },

    async captureTurn(turn): Promise<CaptureResponse> {
      const ctx = await opts.resolveContext();
      return opts.client.capture({
        user_content: turn.userText,
        assistant_content: turn.assistantText,
        messages: turn.messages,
        session_key: ctx.sessionKey,
        session_id: ctx.sessionId,
        user_id: ctx.userId,
      });
    },

    searchMemories(params: MemorySearchRequest): Promise<MemorySearchResponse> {
      return opts.client.searchMemories(params);
    },

    async searchConversations(params): Promise<ConversationSearchResponse> {
      const ctx = await opts.resolveContext();
      return opts.client.searchConversations({
        query: params.query,
        limit: params.limit,
        session_key: params.sessionKey ?? ctx.sessionKey,
      });
    },

    async endSession(): Promise<SessionEndResponse> {
      const ctx = await opts.resolveContext();
      return opts.client.endSession({
        session_key: ctx.sessionKey,
        user_id: ctx.userId,
      });
    },
  };
}
