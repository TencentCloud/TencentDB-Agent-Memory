/**
 * HTTP client — forwards MCP tool calls to the Hono knowledge API.
 *
 * Each MCP tool maps to a POST endpoint on the knowledge service.
 * The client sends the tool arguments as JSON body and returns the
 * ApiResponseEnvelope data field (or error).
 */

import { createLogger } from "../logger.js";
import { isValidIdSegment, SERVICE_ID_HEADER } from "../api-helpers.js";

const log = createLogger("mcp-http");

export interface HttpClientOptions {
  baseUrl: string;
  serviceId: string;
  /** Optional bearer token for auth. */
  token?: string;
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
  if (!isValidIdSegment(opts.serviceId)) {
    throw new Error("KNOWLEDGE_API_SERVICE_ID must be a valid service instance ID");
  }
  const url = `${opts.baseUrl.replace(/\/$/, "")}/v3${endpoint}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [SERVICE_ID_HEADER]: opts.serviceId,
  };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
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
