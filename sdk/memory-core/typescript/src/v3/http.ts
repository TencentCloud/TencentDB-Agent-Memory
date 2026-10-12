/** Strict HTTP transport used exclusively by v3 SDK clients. */

import { Agent } from "undici";
import { ParamError, TDAMError } from "../errors.js";
import type { HttpTransportOptions } from "../http.js";
import type { ApiResponseEnvelope } from "../types.js";

export class V3HttpTransport {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly timeout: number;
  private readonly dispatcher?: Agent;

  constructor(opts: HttpTransportOptions) {
    let endpoint: URL;
    try {
      endpoint = new URL(opts.endpoint);
    } catch {
      throw new ParamError("endpoint must be a valid HTTP(S) URL");
    }
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
      throw new ParamError("endpoint must be a valid HTTP(S) URL");
    }
    if (!opts.apiKey?.trim()) throw new ParamError("apiKey must be provided");
    if (!opts.serviceId?.trim()) throw new ParamError("serviceId must be provided");
    const timeout = opts.timeout ?? 30_000;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new ParamError("timeout must be a positive number");
    }

    this.endpoint = opts.endpoint.replace(/\/+$/, "");
    this.timeout = timeout;
    this.headers = {
      Authorization: `Bearer ${opts.apiKey}`,
      "x-tdai-service-id": opts.serviceId,
      "Content-Type": "application/json",
    };
    if (opts.userKey) this.headers["x-tdai-user-key"] = opts.userKey;
    if (opts.rejectUnauthorized === false) {
      this.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    }
  }

  async post<T = unknown>(
    path: string,
    body: Record<string, unknown> = {},
  ): Promise<T & { trace_id?: string }> {
    return this.request<T>("POST", path, body);
  }

  async get<T = unknown>(
    path: string,
    query: Record<string, unknown> = {},
  ): Promise<T & { trace_id?: string }> {
    return this.request<T>("GET", path, query);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    params: Record<string, unknown>,
  ): Promise<T & { trace_id?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const query = method === "GET"
        ? new URLSearchParams(Object.entries(params)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, String(value)]))
        : undefined;
      const fetchOptions: RequestInit & { dispatcher?: Agent } = {
        method,
        headers: this.headers,
        ...(method === "POST" ? { body: JSON.stringify(params) } : {}),
        signal: controller.signal,
      };
      if (this.dispatcher) fetchOptions.dispatcher = this.dispatcher;
      const url = `${this.endpoint}${path}${query && query.size > 0 ? `?${query.toString()}` : ""}`;
      const response = await fetch(url, fetchOptions as RequestInit);
      const responseText = await response.text().catch(() => "");
      const headerRequestId =
        response.headers.get("x-qcloud-transaction-id") ??
        response.headers.get("x-trace-id") ??
        "";

      let envelope: ApiResponseEnvelope<T>;
      try {
        envelope = JSON.parse(responseText) as ApiResponseEnvelope<T>;
      } catch {
        throw new TDAMError(
          response.ok ? -1 : response.status,
          responseText || `HTTP ${response.status} returned a non-JSON response`,
          headerRequestId,
        );
      }

      const businessCode = typeof envelope.code === "number" ? envelope.code : undefined;
      if (!response.ok || businessCode !== 0) {
        const code = businessCode && businessCode !== 0 ? businessCode : response.status;
        const details =
          envelope.data && typeof envelope.data === "object"
            ? (envelope.data as Record<string, unknown>)
            : undefined;
        throw new TDAMError(
          code,
          envelope.message || `HTTP ${response.status}`,
          headerRequestId || envelope.request_id || "",
          details,
        );
      }

      const result = (envelope.data ?? {}) as T & { trace_id?: string };
      const traceId = response.headers.get("x-trace-id");
      if (traceId && result && typeof result === "object") {
        (result as Record<string, unknown>).trace_id = traceId;
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}
