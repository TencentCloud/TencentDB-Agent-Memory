/**
 * Internal transport for the packaged hook and MCP executables.
 * This module is intentionally not exported as a public adapter SDK.
 */
const DEFAULT_BASE_URL = "http://127.0.0.1:8420";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ERROR_BODY_CHARS = 500;

export class GatewayClientError extends Error {
  constructor(message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = "GatewayClientError";
    this.code = details.code || "GATEWAY_ERROR";
    this.path = details.path;
    this.status = details.status;
    this.responseBody = details.responseBody;
  }
}

export function resolveGatewayBaseUrl() {
  if (process.env.MEMORY_TENCENTDB_GATEWAY_URL) {
    return process.env.MEMORY_TENCENTDB_GATEWAY_URL.replace(/\/+$/, "");
  }
  const host = process.env.MEMORY_TENCENTDB_GATEWAY_HOST || "127.0.0.1";
  const port = process.env.MEMORY_TENCENTDB_GATEWAY_PORT || "8420";
  return `http://${host}:${port}`.replace(/\/+$/, "");
}

export function resolveGatewayApiKey() {
  return (
    process.env.MEMORY_TENCENTDB_GATEWAY_API_KEY ||
    process.env.TDAI_GATEWAY_API_KEY ||
    ""
  ).trim();
}

export function resolveGatewayTimeoutMs(value = process.env.MEMORY_TENCENTDB_GATEWAY_TIMEOUT_MS) {
  if (value == null || value === "") return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TIMEOUT_MS;
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function gatewayUrl(path, opts = {}) {
  const baseUrl = normalizeBaseUrl(opts.baseUrl || resolveGatewayBaseUrl());
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function truncateBody(text) {
  const normalized = String(text || "").trim();
  if (normalized.length <= MAX_ERROR_BODY_CHARS) return normalized;
  return `${normalized.slice(0, MAX_ERROR_BODY_CHARS)}…`;
}

function parseJson(text) {
  if (!text) return {};
  return JSON.parse(text);
}

async function parseGatewayResponse(res, path) {
  const text = await res.text();
  let data;
  try {
    data = parseJson(text);
  } catch (cause) {
    const responseBody = truncateBody(text);
    if (!res.ok) {
      throw new GatewayClientError(
        `Gateway ${path} failed with HTTP ${res.status}${responseBody ? `: ${responseBody}` : ""}`,
        { code: "HTTP_ERROR", path, status: res.status, responseBody, cause },
      );
    }
    throw new GatewayClientError(`Gateway ${path} returned invalid JSON`, {
      code: "INVALID_JSON",
      path,
      status: res.status,
      responseBody,
      cause,
    });
  }

  if (!res.ok) {
    const responseBody = truncateBody(text);
    const detail = typeof data?.error === "string" && data.error.trim()
      ? data.error.trim()
      : responseBody;
    throw new GatewayClientError(
      `Gateway ${path} failed with HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
      { code: "HTTP_ERROR", path, status: res.status, responseBody },
    );
  }
  return data;
}

async function gatewayRequest(method, path, body, opts = {}) {
  const apiKey = opts.apiKey ?? resolveGatewayApiKey();
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const timeoutMs = resolveGatewayTimeoutMs(opts.timeoutMs);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  try {
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const res = await fetchImpl(gatewayUrl(path, opts), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    return await parseGatewayResponse(res, path);
  } catch (cause) {
    if (cause instanceof GatewayClientError) throw cause;
    if (controller.signal.aborted) {
      throw new GatewayClientError(`Gateway ${path} timed out after ${timeoutMs}ms`, {
        code: "TIMEOUT",
        path,
        cause,
      });
    }
    throw new GatewayClientError(
      `Gateway ${path} request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { code: "NETWORK_ERROR", path, cause },
    );
  } finally {
    clearTimeout(timeout);
  }
}

export function gatewayPost(path, body, opts = {}) {
  return gatewayRequest("POST", path, body, opts);
}

export function gatewayGet(path, opts = {}) {
  return gatewayRequest("GET", path, undefined, opts);
}
