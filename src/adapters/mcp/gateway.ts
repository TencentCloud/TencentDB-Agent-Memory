export interface MemoryGatewayOptions {
  baseUrl?: string;
  apiKey?: string;
  userId?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export class MemoryGatewayClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly userId?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: MemoryGatewayOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.TDAI_GATEWAY_URL ?? "http://127.0.0.1:8420").replace(/\/$/, "");
    this.apiKey = options.apiKey ?? process.env.TDAI_GATEWAY_API_KEY;
    this.userId = options.userId ?? process.env.TDAI_USER_ID;
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async post<T>(pathname: string, body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          ...body,
          ...(this.userId ? { user_id: this.userId } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Gateway ${pathname} returned HTTP ${response.status}`);
      }
      return await response.json() as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}