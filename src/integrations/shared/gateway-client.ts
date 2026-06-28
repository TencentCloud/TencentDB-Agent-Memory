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

export async function gatewayPost(path, body, opts = {}) {
  const baseUrl = opts.baseUrl || resolveGatewayBaseUrl() || DEFAULT_BASE_URL;
  const apiKey = opts.apiKey ?? resolveGatewayApiKey();
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(data.error || `Gateway ${path} failed: ${res.status}`);
  }
  return data;
}

export async function gatewayGet(path, opts = {}) {
  const baseUrl = opts.baseUrl || resolveGatewayBaseUrl() || DEFAULT_BASE_URL;
  const apiKey = opts.apiKey ?? resolveGatewayApiKey();
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(`${baseUrl}${path}`, { headers });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(data.error || `Gateway ${path} failed: ${res.status}`);
  }
  return data;
}
