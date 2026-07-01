import { compactObject, optionalSearchLimit, optionalString, requireString } from "./params.js";

export interface GatewayHealthResponse {
  status: "ok" | "degraded";
  version: string;
  uptime: number;
  stores: {
    vectorStore: boolean;
    embeddingService: boolean;
  };
}

export interface GatewayRecallResponse {
  context: string;
  prepend_context?: string;
  append_system_context?: string;
  strategy?: string;
  memory_count?: number;
}

export interface GatewayCaptureResponse {
  l0_recorded: number;
  scheduler_notified: boolean;
}

export interface GatewayMemorySearchResponse {
  results: string;
  total: number;
  strategy: string;
}

export interface GatewayConversationSearchResponse {
  results: string;
  total: number;
}

export interface GatewaySessionEndResponse {
  flushed: boolean;
}

export interface TdaiGatewayClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
}

export class TdaiGatewayClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(options: TdaiGatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey?.trim() || undefined;
    this.timeoutMs = options.timeoutMs;
  }

  async health(): Promise<GatewayHealthResponse> {
    return this.request<GatewayHealthResponse>("GET", "/health");
  }

  async recall(args: Record<string, unknown>, defaultSessionKey: string): Promise<GatewayRecallResponse> {
    return this.request<GatewayRecallResponse>("POST", "/recall", {
      query: requireString(args, "query"),
      session_key: optionalString(args, "session_key") || defaultSessionKey,
      user_id: optionalString(args, "user_id"),
    });
  }

  async capture(args: Record<string, unknown>, defaultSessionKey: string): Promise<GatewayCaptureResponse> {
    return this.request<GatewayCaptureResponse>("POST", "/capture", {
      user_content: requireString(args, "user_content"),
      assistant_content: requireString(args, "assistant_content"),
      session_key: optionalString(args, "session_key") || defaultSessionKey,
      session_id: optionalString(args, "session_id"),
      user_id: optionalString(args, "user_id"),
      messages: Array.isArray(args.messages) ? args.messages : undefined,
    });
  }

  async captureTurn(args: {
    userContent: string;
    assistantContent: string;
    sessionKey: string;
    sessionId?: string;
    userId?: string;
    messages?: unknown[];
  }): Promise<GatewayCaptureResponse> {
    return this.request<GatewayCaptureResponse>("POST", "/capture", {
      user_content: args.userContent,
      assistant_content: args.assistantContent,
      session_key: args.sessionKey,
      session_id: args.sessionId,
      user_id: args.userId,
      messages: args.messages,
    });
  }

  async searchMemories(args: Record<string, unknown>): Promise<GatewayMemorySearchResponse> {
    return this.request<GatewayMemorySearchResponse>("POST", "/search/memories", {
      query: requireString(args, "query"),
      limit: optionalSearchLimit(args),
      type: optionalString(args, "type"),
      scene: optionalString(args, "scene"),
    });
  }

  async searchConversations(args: Record<string, unknown>): Promise<GatewayConversationSearchResponse> {
    return this.request<GatewayConversationSearchResponse>("POST", "/search/conversations", {
      query: requireString(args, "query"),
      limit: optionalSearchLimit(args),
      session_key: optionalString(args, "session_key"),
    });
  }

  async endSession(args: Record<string, unknown>, defaultSessionKey: string): Promise<GatewaySessionEndResponse> {
    return this.request<GatewaySessionEndResponse>("POST", "/session/end", {
      session_key: optionalString(args, "session_key") || defaultSessionKey,
      user_id: optionalString(args, "user_id"),
    });
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {};
      if (method === "POST") headers["Content-Type"] = "application/json";
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: method === "POST" ? JSON.stringify(compactObject(body ?? {})) : undefined,
        signal: controller.signal,
      });

      const text = await response.text();
      const payload = parsePayload(text);
      if (!response.ok) {
        throw new Error(`Gateway ${method} ${path} failed (${response.status}): ${formatPayload(payload)}`);
      }
      return payload as T;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Gateway ${method} ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

function parsePayload(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatPayload(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
