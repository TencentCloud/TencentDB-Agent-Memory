/**
 * TencentDB Agent Memory - Codex CLI / Claude Code TypeScript client.
 *
 * Thin HTTP wrapper for MCP-native hosts that prefer a typed client
 * over raw JSON-RPC. ~50 lines, zero external dependencies beyond Node stdlib.
 */

export interface TdaiClientConfig {
  gatewayUrl?: string;
  apiKey?: string;
  timeout?: number;
}

export interface RecallResult {
  context: string;
  strategy?: string;
  memory_count?: number;
}

export interface CaptureResult {
  l0_recorded: number;
  scheduler_notified: boolean;
}

export interface SearchResult {
  results: string;
  total: number;
  strategy?: string;
}

export interface HealthResult {
  status: string;
  version: string;
  uptime: number;
  stores: { vectorStore: boolean; embeddingService: boolean };
}

export class TdaiMemoryClient {
  private baseUrl: string;
  private apiKey: string;
  private timeout: number;

  constructor(config: TdaiClientConfig = {}) {
    this.baseUrl = (config.gatewayUrl || process.env.TDAI_GATEWAY_URL || "http://127.0.0.1:8420").replace(/\/$/, "");
    this.apiKey = config.apiKey || process.env.TDAI_API_KEY || "";
    this.timeout = config.timeout || 30000;
  }

  private async request<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const resp = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        throw new Error(`TDAI Gateway ${resp.status}: ${(err as any).error || resp.statusText}`);
      }
      return (await resp.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<HealthResult> {
    return this.request("GET", "/health");
  }

  async recall(query: string, sessionKey: string, userId?: string): Promise<RecallResult> {
    return this.request("POST", "/recall", { query, session_key: sessionKey, ...(userId && { user_id: userId }) });
  }

  async capture(userContent: string, assistantContent: string, sessionKey: string, opts?: { sessionId?: string; userId?: string }): Promise<CaptureResult> {
    return this.request("POST", "/capture", {
      user_content: userContent,
      assistant_content: assistantContent,
      session_key: sessionKey,
      ...opts,
    });
  }

  async searchMemories(query: string, opts?: { limit?: number; type?: string; scene?: string }): Promise<SearchResult> {
    return this.request("POST", "/search/memories", { query, ...opts });
  }

  async searchConversations(query: string, opts?: { limit?: number; sessionKey?: string }): Promise<SearchResult> {
    return this.request("POST", "/search/conversations", {
      query,
      ...(opts?.limit && { limit: opts.limit }),
      ...(opts?.sessionKey && { session_key: opts.sessionKey }),
    });
  }

  async endSession(sessionKey: string): Promise<{ flushed: boolean }> {
    return this.request("POST", "/session/end", { session_key: sessionKey });
  }
}
