import type {
  CapturePayload,
  ModelProxyGateway,
  RecallResponseCompat,
} from "./types.js";

export interface HttpModelProxyGatewayOptions {
  baseUrl: string;
  apiKey?: string;
  /** Recall is on the model latency path and intentionally has a short budget. */
  recallTimeoutMs?: number;
  /** Capture and session flush happen off the model latency path. */
  writeTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Gateway URL must use http: or https:");
  }
  if (url.username || url.password) {
    throw new Error("Gateway URL must not contain embedded credentials");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export class HttpModelProxyGateway implements ModelProxyGateway {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly recallTimeoutMs: number;
  private readonly writeTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpModelProxyGatewayOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.recallTimeoutMs = options.recallTimeoutMs ?? 300;
    this.writeTimeoutMs = options.writeTimeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  recall(input: {
    query: string;
    session_key: string;
    user_id?: string;
  }): Promise<RecallResponseCompat> {
    return this.post<RecallResponseCompat>("/recall", input, this.recallTimeoutMs);
  }

  capture(input: CapturePayload): Promise<unknown> {
    return this.post("/capture", input, this.writeTimeoutMs);
  }

  endSession(input: {
    session_key: string;
    user_id?: string;
  }): Promise<unknown> {
    return this.post("/session/end", input, this.writeTimeoutMs);
  }

  private async post<T>(
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`TDAI Gateway ${path} returned ${response.status}: ${text.slice(0, 300)}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}
