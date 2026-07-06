/**
 * Adapter SDK — MemoryClient factory.
 *
 * `createMemoryClient()` is the single entry point adapters use to obtain a
 * `MemoryClient`; the discriminated `transport` field selects the wiring:
 *
 *   - `"http"`       → `HttpMemoryClient` (talks to a running TdaiGateway)
 *   - `"in-process"` → `InProcessMemoryClient` (wraps TdaiCore in this process)
 *
 * `resolveClientOptionsFromEnv()` implements the shared env-var convention
 * used by the adapter CLI entries (Claude Code MCP server, Dify server):
 *
 *   TDAI_ADAPTER_TRANSPORT   "http" (default) | "in-process"
 *   TDAI_GATEWAY_URL         http transport base URL (default http://127.0.0.1:8420)
 *   TDAI_GATEWAY_API_KEY     Bearer token for the gateway (same var the gateway reads)
 *   TDAI_ADAPTER_TIMEOUT_MS  http request timeout (default 10000)
 */

import type { Logger } from "../core/types.js";
import { getEnv } from "../utils/env.js";
import type { MemoryClient, TdaiCoreLike } from "./types.js";
import { HttpMemoryClient } from "./transports/http.js";
import { InProcessMemoryClient } from "./transports/in-process.js";

// ============================
// Options
// ============================

export interface HttpClientOptions {
  transport: "http";
  /** Gateway base URL. Default: `http://127.0.0.1:8420`. */
  baseUrl?: string;
  /** Optional Bearer token. */
  apiKey?: string;
  /** Request timeout in ms. Default: 10_000. */
  timeoutMs?: number;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

export interface InProcessClientOptions {
  transport: "in-process";
  /** Pre-built core (DI — the client will not own its lifecycle). */
  core?: TdaiCoreLike;
  /** Overrides for `loadGatewayConfig()` when the client builds its own core. */
  gatewayConfigOverrides?: Record<string, unknown>;
  logger?: Logger;
}

export type MemoryClientOptions = HttpClientOptions | InProcessClientOptions;

// ============================
// Factory
// ============================

export function createMemoryClient(opts: MemoryClientOptions): MemoryClient {
  switch (opts.transport) {
    case "http":
      return new HttpMemoryClient({
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        timeoutMs: opts.timeoutMs,
        fetchImpl: opts.fetchImpl,
        logger: opts.logger,
      });
    case "in-process":
      return new InProcessMemoryClient({
        core: opts.core,
        gatewayConfigOverrides: opts.gatewayConfigOverrides,
        logger: opts.logger,
      });
    default: {
      // Exhaustiveness guard — unreachable when callers respect the union.
      const invalid = opts as { transport?: string };
      throw new Error(
        `Unknown MemoryClient transport: ${String(invalid.transport)} (expected "http" or "in-process")`,
      );
    }
  }
}

/**
 * Resolve `MemoryClientOptions` from environment variables (see module doc).
 * Unset/blank vars fall back to defaults; an unrecognized
 * `TDAI_ADAPTER_TRANSPORT` value falls back to "http" with a warning.
 */
export function resolveClientOptionsFromEnv(logger?: Logger): MemoryClientOptions {
  const rawTransport = (getEnv("TDAI_ADAPTER_TRANSPORT") ?? "").trim().toLowerCase();

  if (rawTransport === "in-process") {
    return { transport: "in-process", logger };
  }
  if (rawTransport && rawTransport !== "http") {
    logger?.warn(
      `[tdai-adapter] Unknown TDAI_ADAPTER_TRANSPORT="${rawTransport}" — falling back to "http"`,
    );
  }

  const baseUrl = (getEnv("TDAI_GATEWAY_URL") ?? "").trim() || undefined;
  const apiKey = (getEnv("TDAI_GATEWAY_API_KEY") ?? "").trim() || undefined;
  const rawTimeout = (getEnv("TDAI_ADAPTER_TIMEOUT_MS") ?? "").trim();
  const parsedTimeout = rawTimeout ? Number.parseInt(rawTimeout, 10) : NaN;
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : undefined;

  return { transport: "http", baseUrl, apiKey, timeoutMs, logger };
}
