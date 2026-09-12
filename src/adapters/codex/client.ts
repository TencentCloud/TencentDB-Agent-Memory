/**
 * CodexMemoryAdapter — TypeScript client adapter for Codex-style agents.
 *
 * Codex does not run inside the OpenClaw plugin host. This adapter treats the
 * TDAI Gateway as the stable boundary and maps Codex turn/session data to the
 * same HTTP contract used by other out-of-process platforms.
 */

import type {
  CaptureResponse,
  ConversationSearchResponse,
  HealthResponse,
  MemorySearchResponse,
  RecallResponse,
  SessionEndResponse,
} from "../../gateway/types.js";

type FetchLike = typeof fetch;

export interface CodexMemoryAdapterOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  /**
   * Default session identity for single-thread Codex integrations.
   * Multi-session callers should pass sessionKey per operation so unrelated
   * conversations cannot share the same memory scope.
   */
  defaultSessionKey?: string;
  fetch?: FetchLike;
}

export interface CodexRecallInput {
  query: string;
  sessionKey?: string;
  userId?: string;
}

export interface CodexCaptureTurnInput {
  userContent: string;
  assistantContent: string;
  sessionKey?: string;
  sessionId?: string;
  userId?: string;
  messages?: unknown[];
}

export interface CodexMemorySearchInput {
  query: string;
  limit?: number;
  type?: string;
  scene?: string;
}

export interface CodexConversationSearchInput {
  query: string;
  limit?: number;
  sessionKey?: string;
}

export interface CodexSessionEndInput {
  sessionKey?: string;
  userId?: string;
}

export class CodexMemoryAdapter {
  readonly baseUrl: string;
  readonly defaultSessionKey?: string;

  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(opts: CodexMemoryAdapterOptions = {}) {
    const baseUrl = opts.baseUrl?.trim() || "http://127.0.0.1:8420";
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey?.trim() || undefined;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.defaultSessionKey = opts.defaultSessionKey?.trim() || undefined;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;

    if (!this.fetchImpl) {
      throw new Error("CodexMemoryAdapter requires a fetch implementation");
    }
  }

  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/health");
  }

  async recall(input: CodexRecallInput): Promise<RecallResponse> {
    const sessionKey = this.resolveSessionKey(input.sessionKey);
    return this.request<RecallResponse>("POST", "/recall", {
      query: input.query,
      session_key: sessionKey,
      ...(input.userId ? { user_id: input.userId } : {}),
    });
  }

  async buildPromptContext(input: CodexRecallInput): Promise<string> {
    const response = await this.recall(input);
    return response.context ?? "";
  }

  async captureTurn(input: CodexCaptureTurnInput): Promise<CaptureResponse> {
    const sessionKey = this.resolveSessionKey(input.sessionKey);
    return this.request<CaptureResponse>("POST", "/capture", {
      user_content: input.userContent,
      assistant_content: input.assistantContent,
      session_key: sessionKey,
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      ...(input.userId ? { user_id: input.userId } : {}),
      ...(input.messages ? { messages: input.messages } : {}),
    });
  }

  async searchMemories(input: CodexMemorySearchInput): Promise<MemorySearchResponse> {
    return this.request<MemorySearchResponse>("POST", "/search/memories", {
      query: input.query,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.type ? { type: input.type } : {}),
      ...(input.scene ? { scene: input.scene } : {}),
    });
  }

  async searchConversations(input: CodexConversationSearchInput): Promise<ConversationSearchResponse> {
    return this.request<ConversationSearchResponse>("POST", "/search/conversations", {
      query: input.query,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.sessionKey ? { session_key: input.sessionKey } : {}),
    });
  }

  async endSession(input: CodexSessionEndInput = {}): Promise<SessionEndResponse> {
    const sessionKey = this.resolveSessionKey(input.sessionKey);
    return this.request<SessionEndResponse>("POST", "/session/end", {
      session_key: sessionKey,
      ...(input.userId ? { user_id: input.userId } : {}),
    });
  }

  private resolveSessionKey(sessionKey?: string): string {
    // defaultSessionKey is only a single-session convenience; multi-thread
    // integrations must pass sessionKey explicitly for every scoped operation.
    const resolved = sessionKey?.trim() || this.defaultSessionKey;
    if (!resolved) {
      throw new Error("sessionKey is required for Codex memory operations");
    }
    return resolved;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const payload = await readJsonResponse(response);
      if (!response.ok) {
        const message = getGatewayErrorMessage(payload);
        throw new Error(`TDAI Gateway ${method} ${path} failed with ${response.status}: ${message}`);
      }
      return payload as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createCodexMemoryAdapterFromEnv(
  env: Record<string, string | undefined> = process.env,
): CodexMemoryAdapter {
  return new CodexMemoryAdapter({
    baseUrl: env.MEMORY_TENCENTDB_GATEWAY_URL ?? env.TDAI_GATEWAY_URL,
    apiKey: env.MEMORY_TENCENTDB_GATEWAY_API_KEY ?? env.TDAI_GATEWAY_API_KEY,
    defaultSessionKey: env.CODEX_SESSION_ID ?? env.CODEX_THREAD_ID,
  });
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function getGatewayErrorMessage(payload: unknown): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: unknown }).error;
    const message = stringifyGatewayError(error);
    if (message) return message;
  }
  return "unknown error";
}

function stringifyGatewayError(error: unknown): string | undefined {
  if (typeof error === "string") {
    const trimmed = error.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }

    try {
      const serialized = JSON.stringify(error);
      return serialized && serialized.length > 0 ? serialized : undefined;
    } catch {
      return String(error);
    }
  }

  if (error !== undefined && error !== null) {
    return String(error);
  }
  return undefined;
}
