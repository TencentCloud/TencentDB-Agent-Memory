/** Transparent, authenticated proxy for the Files API used by modern dsh. */

import type { Context } from "hono";
import { verifyUserKey } from "./auth.js";
import { extractBearerToken } from "./opik.js";
import type { ProxyConfig } from "./types.js";

const SKIP_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
]);

const SKIP_RESPONSE_HEADERS = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
]);

/** Resolve a Files API URL from an upstream base or chat-completions endpoint. */
export function resolveDshFilesUpstreamUrl(
  base: string,
  fileId?: string,
  search = "",
): string {
  const url = new URL(base);
  url.pathname = url.pathname
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/, "");
  url.pathname = `${url.pathname}/files${fileId ? `/${encodeURIComponent(fileId)}` : ""}`
    .replace(/\/{2,}/g, "/");
  url.search = search;
  return url.toString();
}

function requestHeaders(c: Context, apiKey: string): Headers {
  const headers = new Headers();
  c.req.raw.headers.forEach((value, key) => {
    if (!SKIP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  if (apiKey) {
    headers.set("authorization", `Bearer ${apiKey}`);
    headers.delete("x-api-key");
  }
  return headers;
}

function responseHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, key) => {
    if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  return headers;
}

/** Forward one dsh Files API operation without entering chat-memory pipelines. */
export async function handleDshFilesEndpoint(
  c: Context,
  config: ProxyConfig,
): Promise<Response> {
  const spaceId = c.req.param("spaceId") ?? "";
  const clientKey = extractBearerToken(
    c.req.header("authorization") ?? c.req.header("Authorization") ?? "",
  ) ?? c.req.header("x-api-key") ?? "";
  const verification = await verifyUserKey(clientKey, spaceId);
  if (verification.rejected) {
    return c.json({
      error: "Authentication failed",
      detail: verification.rejectReason ?? "unknown",
    }, 401);
  }

  const agentUpstream = config.upstream.agents?.dsh;
  const upstreamBase = agentUpstream?.url ?? config.upstream.url;
  const upstreamKey = agentUpstream
    ? (agentUpstream.apiKey ?? "")
    : config.upstream.apiKey;
  const incoming = new URL(c.req.url);
  const upstreamUrl = resolveDshFilesUpstreamUrl(
    upstreamBase,
    c.req.param("fileId"),
    incoming.search,
  );

  const method = c.req.method.toUpperCase();
  const options: RequestInit = {
    method,
    headers: requestHeaders(c, upstreamKey),
  };
  if (method === "POST") options.body = await c.req.arrayBuffer();
  const timeoutMs = config.server.forwardTimeoutMs ?? 0;
  if (timeoutMs > 0) {
    options.signal = AbortSignal.timeout(timeoutMs);
  }

  try {
    const upstream = await fetch(upstreamUrl, options);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders(upstream.headers),
    });
  } catch (error: unknown) {
    return c.json({
      error: "Files API upstream request failed",
      detail: error instanceof Error ? error.message : String(error),
    }, 502);
  }
}
