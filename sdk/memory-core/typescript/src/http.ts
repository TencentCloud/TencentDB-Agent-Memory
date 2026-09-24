/**
 * Low-level HTTP transport for the TencentDB Agent Memory v2 API.
 *
 * - Auth: `Authorization: Bearer {apiKey}` + `x-tdai-service-id` + optional `x-tdai-user-key`
 * - Envelope unwrap: `code === 0` → return `data`; else throw `TDAMError`
 * - trace_id: extracted from `x-trace-id` response header
 * - Zero runtime dependencies — uses native `fetch`.
 * - TLS: `rejectUnauthorized` defaults to `false` (self-signed cert friendly).
 */

import { TDAMError } from "./errors.js";
import type { ApiResponseEnvelope } from "./types.js";

export interface HttpTransportOptions {
  endpoint: string;
  /** 网关 Bearer 密钥（KERNEL_AUTH_TOKEN / TDAI_GATEWAY_API_KEY）。 */
  apiKey: string;
  /** 记忆实例 ID（x-tdai-service-id）。 */
  serviceId: string;
  /** 用户 API 密钥（x-tdai-user-key）；user/create、user/delete 须 system_admin key。 */
  userKey?: string;
  timeout?: number;
  /** Whether to reject self-signed / invalid TLS certs. Default: false. */
  rejectUnauthorized?: boolean;
}

export class HttpTransport {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly timeout: number;
  private dispatcher: unknown;

  constructor(opts: HttpTransportOptions) {
    this.endpoint = opts.endpoint.replace(/\/+$/, "");
    this.timeout = opts.timeout ?? 30_000;
    this.headers = {
      Authorization: `Bearer ${opts.apiKey}`,
      "x-tdai-service-id": opts.serviceId,
      "Content-Type": "application/json",
    };
    if (opts.userKey) {
      this.headers["x-tdai-user-key"] = opts.userKey;
    }

    // When rejectUnauthorized=false (default), create an undici Agent that
    // skips TLS certificate validation. This mirrors the Python SDK's
    // `verify=False` default for self-signed cert environments.
    if (opts.rejectUnauthorized !== true) {
      try {
        // Node 18+ bundles undici; dynamic import to keep zero-dep for bundlers
        const { Agent } = require("undici");
        this.dispatcher = new Agent({
          connect: { rejectUnauthorized: false },
        });
      } catch {
        // If undici is not available (browser/edge runtime), fall back to
        // process.env which only works in Node.js.
        if (typeof process !== "undefined") {
          process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
        }
      }
    }
  }

  async post<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T & { trace_id?: string }> {
    const url = `${this.endpoint}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const fetchOpts: RequestInit & { dispatcher?: unknown } = {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      };
      if (this.dispatcher) {
        fetchOpts.dispatcher = this.dispatcher;
      }

      const resp = await fetch(url, fetchOpts as RequestInit);

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new TDAMError(resp.status, `HTTP ${resp.status}: ${text}`);
      }

      const envelope = (await resp.json()) as ApiResponseEnvelope<T>;

      if (envelope.code !== 0) {
        const reqId =
          resp.headers.get("x-qcloud-transaction-id") ?? envelope.request_id ?? "";
        const details =
          envelope.data && typeof envelope.data === "object"
            ? (envelope.data as Record<string, unknown>)
            : undefined;
        throw new TDAMError(envelope.code, envelope.message, reqId, details);
      }

      const raw = envelope.data ?? {};
      // Only null/undefined data falls back to an empty object; any other
      // non-object payload (arrays, primitives) is a malformed envelope and
      // must fail as a clean TDAMError — not as bogus data, and not as the
      // raw TypeError the trace-id write below throws on a primitive in
      // strict mode. Same contract the Python transports enforce.
      if (typeof raw !== "object" || Array.isArray(raw)) {
        throw new TDAMError(
          -1,
          "API response data must be a JSON object",
          resp.headers.get("x-qcloud-transaction-id") ?? envelope.request_id ?? "",
        );
      }
      const result = raw as T & { trace_id?: string };
      const traceId = resp.headers.get("x-trace-id");
      if (traceId) {
        (result as Record<string, unknown>).trace_id = traceId;
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}
