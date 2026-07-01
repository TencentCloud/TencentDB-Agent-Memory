export interface GatewayClientOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

export interface GatewayRequestInit extends GatewayClientOptions {
  headers?: Record<string, string>;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:8420";

export function resolveGatewayBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.MEMORY_TENCENTDB_GATEWAY_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const host = env.MEMORY_TENCENTDB_GATEWAY_HOST?.trim() || "127.0.0.1";
  const port = env.MEMORY_TENCENTDB_GATEWAY_PORT?.trim() || "8420";
  return `http://${host}:${port}`.replace(/\/+$/, "");
}

export function resolveGatewayApiKey(env: Record<string, string | undefined> = process.env): string {
  return (
    env.MEMORY_TENCENTDB_GATEWAY_API_KEY ||
    env.TDAI_GATEWAY_API_KEY ||
    ""
  ).trim();
}

export function gatewayUrl(path: string, opts: GatewayClientOptions = {}): string {
  const baseUrl = (opts.baseUrl || resolveGatewayBaseUrl(opts.env)).replace(/\/+$/, "");
  return `${baseUrl || DEFAULT_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

export function gatewayHeaders(opts: GatewayRequestInit = {}): Record<string, string> {
  const apiKey = opts.apiKey ?? resolveGatewayApiKey(opts.env);
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

async function parseGatewayResponse(response: Response, path: string): Promise<unknown> {
  const text = await response.text();
  let parsed: unknown = {};

  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      if (!response.ok) {
        throw new Error(`Gateway ${path} failed: ${response.status} ${text}`);
      }
      throw err;
    }
  }

  if (!response.ok) {
    const error = parsed && typeof parsed === "object" && "error" in parsed
      ? String((parsed as { error: unknown }).error)
      : `Gateway ${path} failed: ${response.status}`;
    throw new Error(error);
  }

  return parsed;
}

export async function gatewayGet<T = unknown>(
  path: string,
  opts: GatewayRequestInit = {},
): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const response = await fetchImpl(gatewayUrl(path, opts), {
    method: "GET",
    headers: gatewayHeaders(opts),
  });
  return parseGatewayResponse(response, path) as Promise<T>;
}

export async function gatewayPost<T = unknown>(
  path: string,
  body: unknown,
  opts: GatewayRequestInit = {},
): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers = gatewayHeaders({
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    },
  });
  const response = await fetchImpl(gatewayUrl(path, opts), {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  return parseGatewayResponse(response, path) as Promise<T>;
}

