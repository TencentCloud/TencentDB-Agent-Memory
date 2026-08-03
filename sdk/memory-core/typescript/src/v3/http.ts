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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const fetchOptions: RequestInit & { dispatcher?: Agent } = {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      };
      if (this.dispatcher) fetchOptions.dispatcher = this.dispatcher;
      const response = await fetch(`${this.endpoint}${path}`, fetchOptions as RequestInit);
      const responseText = await response.text().catch(() => "");
      const headerRequestId =
        response.headers.get("x-qcloud-transaction-id") ??
        response.headers.get("x-trace-id") ??
        "";

      let parsed: unknown;
      try {
        parsed = JSON.parse(responseText) as unknown;
      } catch {
        throw new TDAMError(
          response.ok ? -1 : response.status,
          responseText || `HTTP ${response.status} returned a non-JSON response`,
          headerRequestId,
        );
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TDAMError(-1, "API response must be a JSON object", headerRequestId);
      }
      const envelope = parsed as ApiResponseEnvelope<T>;

      const businessCode = typeof envelope.code === "number" ? envelope.code : undefined;
      if (!response.ok || businessCode !== 0) {
        const code =
          businessCode !== undefined && businessCode !== 0
            ? businessCode
            : response.ok
              ? -1
              : response.status;
        const details =
          envelope.data &&
          typeof envelope.data === "object" &&
          !Array.isArray(envelope.data)
            ? (envelope.data as Record<string, unknown>)
            : undefined;
        throw new TDAMError(
          code,
          envelope.message || `HTTP ${response.status}`,
          headerRequestId || envelope.request_id || "",
          details,
        );
      }

      const data = envelope.data ?? {};
      if (typeof data !== "object" || Array.isArray(data)) {
        throw new TDAMError(-1, "API response data must be a JSON object", headerRequestId);
      }
      const result = data as T & { trace_id?: string };
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
