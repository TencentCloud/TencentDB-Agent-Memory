const DEFAULT_BASE_URL = "http://127.0.0.1:8420";

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

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function gatewayUrl(path, opts = {}) {
  const baseUrl = normalizeBaseUrl(opts.baseUrl || resolveGatewayBaseUrl());
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

async function parseGatewayResponse(res, path) {
  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      if (!res.ok) {
        throw new Error(`Gateway ${path} failed: ${res.status} ${text}`);
      }
      throw err;
    }
  }
  if (!res.ok) {
    throw new Error(data.error || `Gateway ${path} failed: ${res.status}`);
  }
  return data;
}

export async function gatewayPost(path, body, opts = {}) {
  const apiKey = opts.apiKey ?? resolveGatewayApiKey();
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(gatewayUrl(path, opts), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return parseGatewayResponse(res, path);
}

export async function gatewayGet(path, opts = {}) {
  const apiKey = opts.apiKey ?? resolveGatewayApiKey();
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(gatewayUrl(path, opts), { headers });
  return parseGatewayResponse(res, path);
}
