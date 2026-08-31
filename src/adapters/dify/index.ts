import type { CaptureRequest, CaptureResponse, RecallRequest, RecallResponse } from "../../gateway/types.js";

export interface DifyGatewayHttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface DifyGatewayHttpResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}

export type DifyGatewayHttpFetch = (
  url: string,
  init?: DifyGatewayHttpRequestInit,
) => Promise<DifyGatewayHttpResponse>;

export interface DifyGatewayHttpOptions {
  /** Gateway base URL, for example `http://127.0.0.1:8420`. */
  baseUrl: string;
  /** Optional Bearer token matching `TDAI_GATEWAY_API_KEY`. */
  apiKey?: string;
  /** Custom fetch implementation for Dify-side runtimes or tests. */
  fetch?: DifyGatewayHttpFetch;
}

export interface DifyGatewayMemoryPort {
  recall(body: RecallRequest): Promise<RecallResponse>;
  capture(body: CaptureRequest): Promise<CaptureResponse>;
}

export interface DifyWorkflowMemoryAdapterOptions {
  gateway?: DifyGatewayHttpOptions;
  client?: DifyGatewayMemoryPort;
  platform?: string;
  defaultUserId?: string;
}

export interface DifyWorkflowInput {
  query?: string;
  user_content?: string;
  assistant_content?: string;
  answer?: string;
  conversation_id?: string;
  session_id?: string;
  user?: string;
  user_id?: string;
  inputs?: Record<string, unknown>;
  messages?: unknown[];
}

export interface DifyRecallResult {
  session_key: string;
  memory_context: string;
  memory_count: number;
  strategy?: string;
}

export interface DifyCaptureResult extends CaptureResponse {
  session_key: string;
}

export class DifyWorkflowMemoryAdapter {
  private readonly client: DifyGatewayMemoryPort;
  private readonly platform: string;
  private readonly defaultUserId: string;

  constructor(opts: DifyWorkflowMemoryAdapterOptions) {
    if (!opts.client && !opts.gateway) {
      throw new Error("DifyWorkflowMemoryAdapter requires either `client` or `gateway` options");
    }
    this.client = opts.client ?? createDifyGatewayHttpPort(opts.gateway!);
    this.platform = opts.platform ?? "dify";
    this.defaultUserId = opts.defaultUserId ?? "default_user";
  }

  /**
   * Call before the Dify LLM node. Return `memory_context` as a workflow
   * variable and inject it into the system prompt or user prompt template.
   */
  async recall(input: DifyWorkflowInput): Promise<DifyRecallResult> {
    const query = readString(input, "query", "user_content", "prompt", "message");
    if (!query) throw new Error("Dify recall requires `query` or `inputs.query`");

    const identity = this.resolveIdentity(input);
    const result = await this.client.recall({
      query,
      session_key: identity.sessionKey,
      user_id: identity.userId,
    });

    return {
      session_key: identity.sessionKey,
      memory_context: result.context,
      memory_count: result.memory_count ?? 0,
      strategy: result.strategy,
    };
  }

  /**
   * Call after the Dify answer node. This stores the completed turn in L0 and
   * lets the Gateway schedule L1/L2/L3 processing.
   */
  async capture(input: DifyWorkflowInput): Promise<DifyCaptureResult> {
    const userContent = readString(input, "user_content", "query", "prompt", "message");
    const assistantContent = readString(input, "assistant_content", "answer", "response", "output");
    if (!userContent) throw new Error("Dify capture requires `user_content` or `query`");
    if (!assistantContent) throw new Error("Dify capture requires `assistant_content` or `answer`");

    const identity = this.resolveIdentity(input);
    const result = await this.client.capture({
      user_content: userContent,
      assistant_content: assistantContent,
      session_key: identity.sessionKey,
      session_id: identity.sessionId,
      user_id: identity.userId,
      messages: input.messages,
    });

    return {
      ...result,
      session_key: identity.sessionKey,
    };
  }

  buildSessionKey(input: DifyWorkflowInput): string {
    return this.resolveIdentity(input).sessionKey;
  }

  private resolveIdentity(input: DifyWorkflowInput): {
    userId: string;
    conversationId: string;
    sessionId?: string;
    sessionKey: string;
  } {
    const userId = readString(input, "user_id", "user") ?? this.defaultUserId;
    const conversationId =
      readString(input, "conversation_id", "conversationId") ??
      readString(input, "session_id", "sessionId") ??
      "default_conversation";
    const sessionId = readString(input, "session_id", "sessionId");
    return {
      userId,
      conversationId,
      sessionId,
      sessionKey: buildDifySessionKey({
        platform: this.platform,
        userId,
        conversationId,
        sessionId,
      }),
    };
  }
}

export function createDifyWorkflowMemoryAdapter(
  opts: DifyWorkflowMemoryAdapterOptions,
): DifyWorkflowMemoryAdapter {
  return new DifyWorkflowMemoryAdapter(opts);
}

function readString(input: DifyWorkflowInput, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const direct = (input as Record<string, unknown>)[key];
    if (typeof direct === "string" && direct.trim()) return direct;
    const nested = input.inputs?.[key];
    if (typeof nested === "string" && nested.trim()) return nested;
  }
  return undefined;
}

function createDifyGatewayHttpPort(opts: DifyGatewayHttpOptions): DifyGatewayMemoryPort {
  const baseUrl = normalizeGatewayBaseUrl(opts.baseUrl);
  const fetchFn = opts.fetch ?? getGlobalFetch();
  return {
    recall(body) {
      return requestJson<RecallResponse>(fetchFn, baseUrl, opts.apiKey, "/recall", body);
    },
    capture(body) {
      return requestJson<CaptureResponse>(fetchFn, baseUrl, opts.apiKey, "/capture", body);
    },
  };
}

async function requestJson<T>(
  fetchFn: DifyGatewayHttpFetch,
  baseUrl: string,
  apiKey: string | undefined,
  pathname: string,
  body: unknown,
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetchFn(`${baseUrl}${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = parseJsonOrText(text);

  if (!response.ok) {
    const message = typeof parsed === "object" && parsed !== null && "error" in parsed
      ? String((parsed as { error?: unknown }).error)
      : `Dify Gateway request failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  return parsed as T;
}

function buildDifySessionKey(parts: {
  platform: string;
  userId: string;
  conversationId: string;
  sessionId?: string;
}): string {
  const platform = sanitizeSessionKeyPart(parts.platform || "dify");
  const user = sanitizeSessionKeyPart(parts.userId || "default_user");
  const conversation = sanitizeSessionKeyPart(parts.conversationId || "default_conversation");
  const session = parts.sessionId ? `:${sanitizeSessionKeyPart(parts.sessionId)}` : "";
  return `${platform}:${user}:${conversation}${session}`;
}

function normalizeGatewayBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) throw new Error("Dify Gateway baseUrl is required");
  return trimmed.replace(/\/+$/, "");
}

function sanitizeSessionKeyPart(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitized || "unknown";
}

function parseJsonOrText(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function getGlobalFetch(): DifyGatewayHttpFetch {
  const fetchFn = globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("No fetch implementation available; pass `gateway.fetch` to DifyWorkflowMemoryAdapter");
  }
  return (url, init) => fetchFn(url, init as RequestInit) as Promise<DifyGatewayHttpResponse>;
}
