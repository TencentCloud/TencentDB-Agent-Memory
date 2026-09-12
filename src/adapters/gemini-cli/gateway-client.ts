/**
 * TdaiGatewayClient - HTTP client used by the Gemini CLI hook adapter.
 *
 * The Gemini CLI hooks are short-lived processes, so they talk to a
 * persistent TDAI Gateway sidecar instead of booting TdaiCore per event.
 * This mirrors the Hermes provider and keeps recall/capture fast enough
 * for interactive use.
 */

const DEFAULT_TIMEOUT_MS = 5_000;

export interface TdaiGatewayClientOptions {
  /** Gateway base URL, e.g. http://127.0.0.1:8420 */
  baseUrl?: string;
  /** Optional Bearer token. Matches TDAI_GATEWAY_API_KEY. */
  apiKey?: string;
  /** Request timeout in milliseconds. Default: 5000. */
  timeoutMs?: number;
}

export interface TdaiGatewayRecallResult {
  context: string;
  strategy?: string;
  memory_count?: number;
}

export interface TdaiGatewayCaptureResult {
  l0_recorded: number;
  scheduler_notified: boolean;
}

export interface TdaiGatewaySessionEndResult {
  flushed: boolean;
}

export interface TdaiGatewayClientLike {
  recall(params: {
    query: string;
    sessionKey: string;
    userId?: string;
  }): Promise<TdaiGatewayRecallResult>;
  capture(params: {
    userContent: string;
    assistantContent: string;
    sessionKey: string;
    sessionId?: string;
    userId?: string;
  }): Promise<TdaiGatewayCaptureResult>;
  endSession(params: {
    sessionKey: string;
    userId?: string;
  }): Promise<TdaiGatewaySessionEndResult>;
}

/**
 * Resolve Gateway connection settings from environment variables.
 *
 * Supports the same MEMORY_TENCENTDB_GATEWAY_* names used by the Hermes
 * provider, with TDAI_GATEWAY_* as the general fallback.
 */
export function resolveGatewayClientOptions(
  env: Record<string, string | undefined> = process.env,
): TdaiGatewayClientOptions {
  const host = (env.MEMORY_TENCENTDB_GATEWAY_HOST ?? env.TDAI_GATEWAY_HOST ?? "127.0.0.1").trim();
  const port = (env.MEMORY_TENCENTDB_GATEWAY_PORT ?? env.TDAI_GATEWAY_PORT ?? "8420").trim();
  const url = (env.MEMORY_TENCENTDB_GATEWAY_URL ?? env.TDAI_GATEWAY_URL ?? "").trim();
  const apiKey = (env.MEMORY_TENCENTDB_GATEWAY_API_KEY ?? env.TDAI_GATEWAY_API_KEY ?? "").trim() || undefined;
  const rawTimeout = Number(
    env.MEMORY_TENCENTDB_GATEWAY_TIMEOUT_MS ?? env.TDAI_GATEWAY_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
  );

  return {
    baseUrl: url || `http://${host}:${port}`,
    apiKey,
    timeoutMs: Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout
      : DEFAULT_TIMEOUT_MS,
  };
}

export class TdaiGatewayClient implements TdaiGatewayClientLike {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(opts: TdaiGatewayClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://127.0.0.1:8420").replace(/\/+$/, "");
    this.apiKey = opts.apiKey?.trim() || undefined;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async recall(params: {
    query: string;
    sessionKey: string;
    userId?: string;
  }): Promise<TdaiGatewayRecallResult> {
    return this.request<TdaiGatewayRecallResult>("/recall", {
      query: params.query,
      session_key: params.sessionKey,
      ...(params.userId ? { user_id: params.userId } : {}),
    });
  }

  async capture(params: {
    userContent: string;
    assistantContent: string;
    sessionKey: string;
    sessionId?: string;
    userId?: string;
  }): Promise<TdaiGatewayCaptureResult> {
    return this.request<TdaiGatewayCaptureResult>("/capture", {
      user_content: params.userContent,
      assistant_content: params.assistantContent,
      session_key: params.sessionKey,
      ...(params.sessionId ? { session_id: params.sessionId } : {}),
      ...(params.userId ? { user_id: params.userId } : {}),
    });
  }

  async endSession(params: {
    sessionKey: string;
    userId?: string;
  }): Promise<TdaiGatewaySessionEndResult> {
    return this.request<TdaiGatewaySessionEndResult>("/session/end", {
      session_key: params.sessionKey,
      ...(params.userId ? { user_id: params.userId } : {}),
    });
  }

  private async request<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`TDAI Gateway ${path} returned HTTP ${response.status}`);
      }
      return await response.json() as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
