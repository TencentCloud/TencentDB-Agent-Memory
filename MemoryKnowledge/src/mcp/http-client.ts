/**
 * HTTP client — forwards MCP tool calls to the Hono knowledge API.
 *
 * Each MCP tool maps to a POST endpoint on the knowledge service.
 * The client sends the tool arguments as JSON body and returns the
 * ApiResponseEnvelope data field (or error).
 */

import { createLogger } from "../logger.js";

const log = createLogger("mcp-http");

/** Default per-call timeout in ms; aborts a request if the upstream never responds. */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface HttpClientOptions {
  baseUrl: string;
  /** Optional bearer token for auth. */
  token?: string;
  /** Optional per-call timeout in ms (default: 30000). */
  timeoutMs?: number;
}

export interface ApiResponse {
  code: number;
  message: string;
  data: unknown;
}

/**
 * Call a knowledge API endpoint.
 * @param endpoint Path without /v3 prefix (e.g. "/wiki/search", "/code-graph/search")
 * @param body Request body
 * @returns The ApiResponseEnvelope data field on success, or throws on error.
 */
export async function callApi(
  opts: HttpClientOptions,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const url = `${opts.baseUrl.replace(/\/$/, "")}/v3${endpoint}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;

  log.debug(`POST ${url}`);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`fetch failed for ${endpoint}: ${msg}`);
    throw err;
  }

  let json: ApiResponse;
  try {
    json = (await resp.json()) as ApiResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`JSON parse failed for ${endpoint} (status=${resp.status}): ${msg}`);
    throw new Error(`API error: ${resp.status} (invalid JSON)`);
  }

  if (resp.status >= 400 || json.code !== 0) {
    log.warn(`API error on ${endpoint}: status=${resp.status} code=${json.code} message="${json.message}"`);
    throw new Error(json.message || `API error: ${resp.status}`);
  }

  return json.data;
}
