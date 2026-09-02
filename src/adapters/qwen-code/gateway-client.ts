import type {
  CaptureRequest,
  CaptureResponse,
  HealthResponse,
  RecallRequest,
  RecallResponse,
  SessionEndRequest,
  SessionEndResponse,
} from "../../gateway/types.js";
import type { QwenCodeAdapterEnv } from "./types.js";

export interface QwenCodeGatewayClientOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class QwenCodeGatewayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "QwenCodeGatewayError";
  }
}

export class QwenCodeGatewayClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: QwenCodeGatewayClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:8420").replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/health");
  }

  async recall(body: RecallRequest): Promise<RecallResponse> {
    return this.request<RecallResponse>("POST", "/recall", body);
  }

  async capture(body: CaptureRequest): Promise<CaptureResponse> {
    return this.request<CaptureResponse>("POST", "/capture", body);
  }

  async endSession(body: SessionEndRequest): Promise<SessionEndResponse> {
    return this.request<SessionEndResponse>("POST", "/session/end", body);
  }

  private async request<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: unknown = {};
      if (text.trim()) {
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new QwenCodeGatewayError(`Gateway returned invalid JSON from ${pathname}`, response.status);
        }
      }

      if (!response.ok) {
        const error = typeof parsed === "object" && parsed && "error" in parsed
          ? String((parsed as { error?: unknown }).error)
          : response.statusText;
        throw new QwenCodeGatewayError(`Gateway ${pathname} failed: ${error}`, response.status);
      }

      return parsed as T;
    } catch (err) {
      if (err instanceof QwenCodeGatewayError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new QwenCodeGatewayError(`Gateway ${pathname} request failed: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function qwenCodeGatewayClientFromEnv(
  env: QwenCodeAdapterEnv = process.env,
  options: Pick<QwenCodeGatewayClientOptions, "fetchImpl"> = {},
): QwenCodeGatewayClient {
  const host = env["MEMORY_TENCENTDB_GATEWAY_HOST"] ?? env["TDAI_GATEWAY_HOST"] ?? "127.0.0.1";
  const port = env["MEMORY_TENCENTDB_GATEWAY_PORT"] ?? env["TDAI_GATEWAY_PORT"] ?? "8420";
  const baseUrl =
    env["MEMORY_TENCENTDB_GATEWAY_URL"] ??
    env["TDAI_GATEWAY_URL"] ??
    `http://${host}:${port}`;
  const timeoutMs = Number(env["MEMORY_TENCENTDB_GATEWAY_TIMEOUT_MS"] ?? env["TDAI_GATEWAY_TIMEOUT_MS"]);

  return new QwenCodeGatewayClient({
    baseUrl,
    apiKey: env["MEMORY_TENCENTDB_GATEWAY_API_KEY"] ?? env["TDAI_GATEWAY_API_KEY"],
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
    fetchImpl: options.fetchImpl,
  });
}

