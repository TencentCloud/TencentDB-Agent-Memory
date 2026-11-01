/**
 * HTTP client — forwards MCP tool calls to the Hono knowledge API.
 *
 * Each MCP tool maps to a POST endpoint on the knowledge service.
 * The client sends the tool arguments as JSON body and returns the
 * ApiResponseEnvelope data field (or error).
 */

import { createLogger } from "../logger.js";

const log = createLogger("mcp-http");

export interface HttpClientOptions {
  baseUrl: string;
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
  const url = `${opts.baseUrl.replace(/\/$/, "")}/v3${endpoint}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;


  log.debug("POST knowledge API");

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers,
      body: JSON.stringify(body),
    });
  } catch {
    // URLs, transport errors and backend fields may contain credentials or
    // memory. Do not pass their text through MCP tool responses or logs.
    log.error("Knowledge API request failed");
    throw new Error("Knowledge API request failed");
  }

  let json: unknown;
  try {
    json = await resp.json();
  } catch {
    log.error(`Knowledge API returned invalid JSON (status=${resp.status})`);
    throw new Error(`API error: ${resp.status} (invalid JSON)`);
  }

  if (resp.status < 200 || resp.status >= 300
      || typeof json !== "object" || json === null
      || !("code" in json) || json.code !== 0) {
    log.warn(`Knowledge API request rejected (status=${resp.status})`);
    throw new Error(`API error: ${resp.status} (request rejected)`);
  }

  return "data" in json ? json.data : undefined;
}
