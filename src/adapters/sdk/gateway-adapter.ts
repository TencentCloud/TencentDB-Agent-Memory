import type {
  CaptureResponse,
  ConversationSearchResponse,
  HealthResponse,
  MemorySearchResponse,
  RecallResponse,
  SessionEndResponse,
} from "../../gateway/types.js";

export type MemoryAdapterPlatform = "codex" | "codebuddy" | "claude-code" | (string & {});

export interface GatewayMemoryAdapterOptions {
  platform: MemoryAdapterPlatform;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  sessionEndTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  sessionKey: string;
  userId?: string;
}

export interface GatewayRecallParams {
  query: string;
  sessionKey?: string;
  userId?: string;
}

export interface GatewayCaptureParams {
  userContent: string;
  assistantContent: string;
  sessionKey?: string;
  sessionId?: string;
  userId?: string;
  messages?: unknown[];
}

export interface GatewayMemorySearchParams {
  query: string;
  limit?: number;
  type?: string;
  scene?: string;
}

export interface GatewayConversationSearchParams {
  query: string;
  limit?: number;
  sessionKey?: string;
}

export interface PlatformEnv {
  MEMORY_TENCENTDB_GATEWAY_URL?: string;
  MEMORY_TENCENTDB_GATEWAY_API_KEY?: string;
  TDAI_GATEWAY_API_KEY?: string;
}

export interface PlatformAdapterDefaults {
  platform: MemoryAdapterPlatform;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  sessionEndTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  sessionKey?: string;
  userId?: string;
}

export interface MemoryAdapterProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  sessionEndTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  sessionKey?: string;
  userId?: string;
  [key: string]: unknown;
}

export interface MemoryPlatformAdapterDefinition<
  TEnv extends Record<string, string | undefined> = Record<string, string | undefined>,
  TConfig extends MemoryAdapterProviderConfig = MemoryAdapterProviderConfig,
> {
  platform: MemoryAdapterPlatform;
  fromEnv(env: TEnv & PlatformEnv): Omit<PlatformAdapterDefaults, "platform">;
  fromConfig?(config: TConfig, env?: TEnv & PlatformEnv): Omit<PlatformAdapterDefaults, "platform">;
}

export interface MemoryAdapterConfig<TConfig extends MemoryAdapterProviderConfig = MemoryAdapterProviderConfig> {
  provider: MemoryAdapterPlatform;
  config?: TConfig;
}

const DEFAULT_SESSION_END_TIMEOUT_MS = 180_000;

const platformRegistry = new Map<MemoryAdapterPlatform, MemoryPlatformAdapterDefinition>();

export function registerMemoryPlatformAdapter(definition: MemoryPlatformAdapterDefinition): void {
  platformRegistry.set(definition.platform, definition);
}

export function getMemoryPlatformAdapter(provider: MemoryAdapterPlatform): MemoryPlatformAdapterDefinition | undefined {
  return platformRegistry.get(provider);
}

export function listMemoryAdapterProviders(): MemoryAdapterPlatform[] {
  return [...platformRegistry.keys()];
}

export function createGatewayAdapterOptions(
  defaults: PlatformAdapterDefaults,
  overrides: Partial<GatewayMemoryAdapterOptions> = {},
): GatewayMemoryAdapterOptions {
  return {
    platform: overrides.platform ?? defaults.platform,
    baseUrl: overrides.baseUrl ?? defaults.baseUrl,
    apiKey: overrides.apiKey ?? defaults.apiKey,
    timeoutMs: overrides.timeoutMs ?? defaults.timeoutMs,
    sessionEndTimeoutMs: overrides.sessionEndTimeoutMs ?? defaults.sessionEndTimeoutMs,
    fetchImpl: overrides.fetchImpl ?? defaults.fetchImpl,
    sessionKey: overrides.sessionKey ?? defaults.sessionKey ?? process.cwd(),
    userId: overrides.userId ?? defaults.userId,
  };
}

export function createMemoryAdapter<TConfig extends MemoryAdapterProviderConfig>(
  options: MemoryAdapterConfig<TConfig>,
  env: PlatformEnv = process.env,
  overrides: Partial<GatewayMemoryAdapterOptions> = {},
): GatewayMemoryAdapter {
  const definition = platformRegistry.get(options.provider);
  if (!definition) {
    throw new Error(`Unknown memory adapter provider: ${options.provider}`);
  }
  const config = options.config ?? {} as TConfig;
  const defaults = definition.fromConfig
    ? definition.fromConfig(config, env)
    : definition.fromEnv(env);
  return new GatewayMemoryAdapter(createGatewayAdapterOptions({
    platform: definition.platform,
    ...defaults,
  }, overrides));
}

export function createPlatformMemoryAdapter<TEnv extends Record<string, string | undefined>>(
  definition: MemoryPlatformAdapterDefinition<TEnv>,
  env: TEnv & PlatformEnv = process.env as TEnv & PlatformEnv,
  overrides: Partial<GatewayMemoryAdapterOptions> = {},
): GatewayMemoryAdapter {
  return new GatewayMemoryAdapter(createGatewayAdapterOptions({
    platform: definition.platform,
    ...definition.fromEnv(env),
  }, overrides));
}

export class GatewayMemoryAdapter {
  protected readonly platform: MemoryAdapterPlatform;
  protected readonly baseUrl: string;
  protected readonly apiKey?: string;
  protected readonly timeoutMs: number;
  protected readonly sessionEndTimeoutMs: number;
  protected readonly fetchImpl: typeof fetch;
  protected readonly defaultSessionKey: string;
  protected readonly defaultUserId?: string;

  constructor(opts: GatewayMemoryAdapterOptions) {
    this.platform = opts.platform;
    this.baseUrl = (opts.baseUrl ?? "http://127.0.0.1:8420").replace(/\/+$/, "");
    this.apiKey = opts.apiKey?.trim() || undefined;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.sessionEndTimeoutMs = opts.sessionEndTimeoutMs ?? Math.max(this.timeoutMs, DEFAULT_SESSION_END_TIMEOUT_MS);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.defaultSessionKey = opts.sessionKey;
    this.defaultUserId = opts.userId;
  }

  health(): Promise<HealthResponse> {
    return this.get<HealthResponse>("/health");
  }

  recall(params: GatewayRecallParams): Promise<RecallResponse> {
    return this.post<RecallResponse>("/recall", {
      query: params.query,
      session_key: this.resolveSessionKey(params.sessionKey),
      ...this.userField(params.userId),
    });
  }

  capture(params: GatewayCaptureParams): Promise<CaptureResponse> {
    return this.post<CaptureResponse>("/capture", {
      user_content: params.userContent,
      assistant_content: params.assistantContent,
      session_key: this.resolveSessionKey(params.sessionKey),
      ...(params.sessionId ? { session_id: params.sessionId } : {}),
      ...this.userField(params.userId),
      ...(params.messages ? { messages: params.messages } : {}),
    });
  }

  searchMemories(params: GatewayMemorySearchParams): Promise<MemorySearchResponse> {
    return this.post<MemorySearchResponse>("/search/memories", {
      query: params.query,
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
      ...(params.type ? { type: params.type } : {}),
      ...(params.scene ? { scene: params.scene } : {}),
    });
  }

  searchConversations(params: GatewayConversationSearchParams): Promise<ConversationSearchResponse> {
    return this.post<ConversationSearchResponse>("/search/conversations", {
      query: params.query,
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
      session_key: this.resolveSessionKey(params.sessionKey),
    });
  }

  endSession(sessionKey?: string, userId?: string): Promise<SessionEndResponse> {
    return this.request<SessionEndResponse>(
      "/session/end",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_key: this.resolveSessionKey(sessionKey),
          ...this.userField(userId),
        }),
      },
      this.sessionEndTimeoutMs,
    );
  }

  protected resolveSessionKey(sessionKey = this.defaultSessionKey): string {
    return sessionKey.startsWith(`${this.platform}:`) ? sessionKey : `${this.platform}:${sessionKey}`;
  }

  private userField(userId?: string): { user_id?: string } {
    const resolved = userId ?? this.defaultUserId;
    return resolved ? { user_id: resolved } : {};
  }

  private async get<T>(pathname: string): Promise<T> {
    return this.request<T>(pathname, { method: "GET" });
  }

  private async post<T>(pathname: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>(pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async request<T>(pathname: string, init: RequestInit, timeoutMs = this.timeoutMs): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = {
        ...(init.headers as Record<string, string> | undefined),
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      };
      const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Gateway ${pathname} failed: HTTP ${response.status}${text ? ` ${text}` : ""}`);
      }
      return await response.json() as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
