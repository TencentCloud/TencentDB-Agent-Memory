/**
 * Native OpenAI-compatible model-list endpoint handler (`GET /v1/models`).
 *
 * Forwards the upstream model list verbatim to the client, so OpenAI-compatible
 * clients configured against the proxy can discover available models without
 * switching their base URL to a diagnostic channel like `/direct/*`.
 *
 * Deliberately lightweight — it is NOT a conversation turn, so it skips
 * session initialization, context injection, conversation write-back, routing
 * and credit reporting. It only injects the configured upstream credentials
 * (replacing the client's proxy-layer key, which the upstream would reject)
 * and forwards the response status / headers / body unchanged.
 */

import type { Context } from "hono";
import { joinUrl } from "./guard-adapter.js";
import { log } from "./report/log.js";
import type { ProxyConfig } from "./types.js";

/** Hop-by-hop headers that must be stripped before forwarding to upstream. */
const SKIP_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
]);

/** Response headers that would confuse the client if forwarded verbatim. */
const SKIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "transfer-encoding",
  "content-length",
  "connection",
]);

/**
 * Build upstream headers by cloning inbound headers minus hop-by-hop entries.
 *
 * The caller's inbound key is a proxy-layer credential (e.g. `sk-mem-xxx`),
 * which the upstream LLM would reject, so it is replaced with
 * `config.upstream.apiKey` — matching the standard handler behavior.
 */
function buildModelsUpstreamHeaders(c: Context, config: ProxyConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) {
      headers[k] = v;
    }
  }
  if (config.upstream.apiKey) {
    for (const k of Object.keys(headers)) {
      const lower = k.toLowerCase();
      if (lower === "authorization" || lower === "x-api-key") delete headers[k];
    }
    headers["authorization"] = `Bearer ${config.upstream.apiKey}`;
  }
  return headers;
}

/** Copy upstream response headers minus length/encoding fields. */
function filterResponseHeaders(source: Headers): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      out.set(key, value);
    }
  });
  return out;
}

/**
 * Handle a `GET /v1/models` (and its prefixed variants) request.
 *
 * Never throws — returns a 502 on upstream failure.
 */
export async function handleModelsEndpoint(
  c: Context,
  config: ProxyConfig,
): Promise<Response> {
  const path = c.req.path;
  const upstreamUrl = joinUrl(config.upstream.url, path);

  const headers = buildModelsUpstreamHeaders(c, config);
  const forwardTimeoutMs = config.server.forwardTimeoutMs ?? 600_000;

  const fetchOpts: RequestInit = {
    method: "GET",
    headers,
  };
  if (forwardTimeoutMs > 0) {
    fetchOpts.signal = AbortSignal.timeout(forwardTimeoutMs);
  }

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(upstreamUrl, fetchOpts);
  } catch (err: unknown) {
    const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
    const message = isTimeout
      ? `timeout after ${forwardTimeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    log.error(
      "models.forward_failed",
      { path, upstreamUrl },
      err instanceof Error ? err : new Error(String(err)),
    );
    return c.json({ error: "Upstream request failed", detail: message }, 502);
  }

  log.info("models.passthrough", { path, upstreamUrl, status: upstreamResp.status });

  const respBuf = await upstreamResp.arrayBuffer();
  return new Response(respBuf, {
    status: upstreamResp.status,
    headers: filterResponseHeaders(upstreamResp.headers),
  });
}
