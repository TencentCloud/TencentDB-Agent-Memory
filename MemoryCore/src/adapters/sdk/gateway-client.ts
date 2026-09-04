/**
 * MemoryGatewayClient — HTTP client for the TDAI Gateway.
 *
 * Wraps all Gateway v3 API endpoints with timeout, retry, and error
 * handling. This is the TypeScript counterpart to the Python
 * `MemoryTencentdbSdkClient` used by the Hermes plugin.
 *
 * Features:
 * - v3 tenancy isolation (team_id / agent_id / user_id)
 * - Automatic v3 envelope unwrapping
 * - Configurable timeout per request
 * - No external dependencies (uses native fetch)
 */

import type {
  GatewayConnectionConfig,
  TenancyConfig,
  ConversationMessage,
  MemoryItem,
  PersonaContent,
  SceneEntry,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TENANCY: Required<TenancyConfig> = {
  teamId: "default",
  agentId: "default",
  userId: "default",
};

// ============================
// v3 envelope types
// ============================

interface V3Envelope<T = unknown> {
  code: number;
  message?: string;
  data?: T;
}

interface V3SearchData {
  items?: Array<Record<string, unknown>>;
  total?: number;
}

interface V3CoreData {
  content?: string;
  updated_at?: string;
}

interface V3ScenarioListData {
  entries?: Array<Record<string, unknown>>;
}

interface V3ConversationAddData {
  captured_count?: number;
}

// ============================
// MemoryGatewayClient
// ============================

export class MemoryGatewayClient {
  private endpoint: string;
  private apiKey: string | null;
  private serviceId: string;
  private timeoutMs: number;
  private rejectUnauthorized: boolean;

  constructor(config: GatewayConnectionConfig) {
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    this.apiKey = (config.apiKey ?? "").trim() || null;
    this.serviceId = config.serviceId ?? "default";
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.rejectUnauthorized = config.rejectUnauthorized ?? true;
  }

  // -- Private helpers ---------------------------------------------------

  private buildHeaders(contentType: boolean = false): Record<string, string> {
    const headers: Record<string, string> = {};
    if (contentType) {
      headers["Content-Type"] = "application/json";
    }
    headers["Authorization"] = `Bearer ${this.apiKey ?? "local"}`;
    headers["x-tdai-service-id"] = this.serviceId;
    return headers;
  }

  private async post<T = unknown>(
    path: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<V3Envelope<T>> {
    const url = `${this.endpoint}${path}`;
    const controller = new AbortController();
    const timeout = timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders(true),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Gateway ${path} returned ${resp.status}: ${text.slice(0, 200)}`);
      }

      const raw = (await resp.json()) as V3Envelope<T>;
      if (raw.code !== 0) {
        throw new Error(`Gateway ${path} error: code=${raw.code} message=${raw.message ?? "unknown"}`);
      }
      return raw;
    } finally {
      clearTimeout(timer);
    }
  }

  private async get<T = unknown>(
    path: string,
    timeoutMs?: number,
  ): Promise<T> {
    const url = `${this.endpoint}${path}`;
    const controller = new AbortController();
    const timeout = timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const resp = await fetch(url, {
        method: "GET",
        headers: this.buildHeaders(false),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Gateway GET ${path} returned ${resp.status}: ${text.slice(0, 200)}`);
      }
      return (await resp.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private mergeTenancy(tenancy?: TenancyConfig): Required<TenancyConfig> {
    return {
      teamId: tenancy?.teamId ?? DEFAULT_TENANCY.teamId,
      agentId: tenancy?.agentId ?? DEFAULT_TENANCY.agentId,
      userId: tenancy?.userId ?? DEFAULT_TENANCY.userId,
    };
  }

  // -- Public API methods -----------------------------------------------

  /** Check if the Gateway is healthy. */
  async health(timeoutMs: number = 3_000): Promise<{ status: string }> {
    try {
      const result = await this.get<{ status: string }>("/health", timeoutMs);
      return result;
    } catch {
      return { status: "unreachable" };
    }
  }

  /**
   * Recall memories (parallel L1 + L3 + L2 fetch).
   * Returns structured results for the adapter to format.
   */
  async recall(
    query: string,
    tenancy?: TenancyConfig,
    options?: {
      maxResults?: number;
      includePersona?: boolean;
      includeSceneNav?: boolean;
    },
  ): Promise<{
    memories: MemoryItem[];
    persona: PersonaContent | null;
    scenes: SceneEntry[];
  }> {
    const t = this.mergeTenancy(tenancy);
    const maxResults = options?.maxResults ?? 5;
    const includePersona = options?.includePersona ?? true;
    const includeSceneNav = options?.includeSceneNav ?? true;

    // Parallel fetch: L1 search + L3 core read + L2 scenario list
    const tasks: Promise<void>[] = [];
    let memories: MemoryItem[] = [];
    let persona: PersonaContent | null = null;
    let scenes: SceneEntry[] = [];

    // L1 search
    tasks.push(
      this.post<V3SearchData>("/v3/atomic/search", {
        team_id: t.teamId,
        agent_id: t.agentId,
        user_id: t.userId,
        query,
        limit: maxResults,
      }).then((env) => {
        const items = env.data?.items ?? [];
        memories = items.map((item) => ({
          type: String(item.type ?? "unknown"),
          content: String(item.content ?? ""),
          score: typeof item.score === "number" ? item.score : undefined,
          metadata: item,
        }));
      }).catch(() => {
        // Graceful degradation — empty result
      }),
    );

    // L3 persona
    if (includePersona) {
      tasks.push(
        this.post<V3CoreData>("/v3/core/read", {
          team_id: t.teamId,
          agent_id: t.agentId,
          user_id: t.userId,
        }).then((env) => {
          const content = env.data?.content ?? "";
          if (content) {
            persona = {
              content,
              updatedAt: env.data?.updated_at,
            };
          }
        }).catch(() => {
          // Graceful degradation
        }),
      );
    }

    // L2 scene navigation
    if (includeSceneNav) {
      tasks.push(
        this.post<V3ScenarioListData>("/v3/scenario/ls", {
          team_id: t.teamId,
          agent_id: t.agentId,
          user_id: t.userId,
        }).then((env) => {
          const entries = env.data?.entries ?? [];
          scenes = entries.map((entry) => ({
            path: String(entry.path ?? ""),
            summary: entry.summary ? String(entry.summary) : undefined,
            heat: typeof entry.heat === "number" ? entry.heat : undefined,
          }));
        }).catch(() => {
          // Graceful degradation
        }),
      );
    }

    await Promise.allSettled(tasks);

    return { memories, persona, scenes };
  }

  /**
   * Capture conversation messages (L0 recording).
   */
  async capture(
    messages: ConversationMessage[],
    sessionId: string,
    tenancy?: TenancyConfig,
  ): Promise<{ capturedCount: number; success: boolean }> {
    const t = this.mergeTenancy(tenancy);

    try {
      const env = await this.post<V3ConversationAddData>("/v3/conversation/add", {
        team_id: t.teamId,
        agent_id: t.agentId,
        user_id: t.userId,
        session_id: sessionId,
        messages,
      });
      return {
        capturedCount: env.data?.captured_count ?? messages.length,
        success: true,
      };
    } catch {
      return { capturedCount: 0, success: false };
    }
  }

  /**
   * Search L1 structured memories.
   */
  async searchMemories(
    query: string,
    tenancy?: TenancyConfig,
    options?: { limit?: number; type?: string },
  ): Promise<{ items: MemoryItem[]; total: number }> {
    const t = this.mergeTenancy(tenancy);
    const body: Record<string, unknown> = {
      team_id: t.teamId,
      agent_id: t.agentId,
      user_id: t.userId,
      query,
      limit: options?.limit ?? 5,
    };
    if (options?.type) {
      body.type = options.type;
    }

    const env = await this.post<V3SearchData>("/v3/atomic/search", body);
    const items = (env.data?.items ?? []).map((item) => ({
      type: String(item.type ?? "unknown"),
      content: String(item.content ?? ""),
      score: typeof item.score === "number" ? item.score : undefined,
      metadata: item,
    }));
    return { items, total: env.data?.total ?? items.length };
  }

  /**
   * Search L0 raw conversations.
   */
  async searchConversations(
    query: string,
    tenancy?: TenancyConfig,
    options?: { limit?: number; sessionId?: string },
  ): Promise<{ items: MemoryItem[]; total: number }> {
    const t = this.mergeTenancy(tenancy);
    const body: Record<string, unknown> = {
      team_id: t.teamId,
      agent_id: t.agentId,
      user_id: t.userId,
      query,
      limit: options?.limit ?? 5,
    };
    if (options?.sessionId) {
      body.session_id = options.sessionId;
    }

    const env = await this.post<V3SearchData>("/v3/conversation/search", body);
    const items = (env.data?.items ?? []).map((item) => ({
      type: String(item.role ?? "conversation"),
      content: String(item.content ?? ""),
      timestamp: item.timestamp ? String(item.timestamp) : undefined,
      metadata: item,
    })) as MemoryItem[];
    return { items, total: env.data?.total ?? items.length };
  }

  /**
   * Read a scene block by path.
   */
  async readScene(
    path: string,
    tenancy?: TenancyConfig,
  ): Promise<string> {
    const t = this.mergeTenancy(tenancy);
    const env = await this.post<{ content?: string }>("/v3/scenario/read", {
      team_id: t.teamId,
      agent_id: t.agentId,
      user_id: t.userId,
      path,
    });
    return env.data?.content ?? "";
  }

  /** Update the endpoint (for reconnection). */
  updateEndpoint(endpoint: string): void {
    this.endpoint = endpoint.replace(/\/+$/, "");
  }

  /** Get the current endpoint. */
  getEndpoint(): string {
    return this.endpoint;
  }
}
