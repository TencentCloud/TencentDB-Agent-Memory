/**
 * Claude Code adapter — newline-delimited JSON-RPC 2.0 framing.
 *
 * The MCP stdio transport (spec rev 2025-06-18) frames messages as single
 * lines of UTF-8 JSON separated by `\n`. This module supplies the message
 * types, error codes, and parse/serialize helpers; it deliberately implements
 * ONLY what the MCP subset in `mcp-server.ts` needs — no batching (the 2025
 * spec removed JSON-RPC batching), no HTTP framing.
 *
 * Hand-rolled instead of depending on `@modelcontextprotocol/sdk` to keep the
 * repo's zero-framework ethos (the Gateway likewise uses raw `node:http`) and
 * to avoid adding a dependency for ~100 lines of protocol.
 */

// ============================
// Message types
// ============================

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

/** A notification is a request without an `id` — it MUST NOT be answered. */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

// ============================
// Standard error codes (JSON-RPC 2.0 §5.1)
// ============================

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

// ============================
// Helpers
// ============================

export function successResponse(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: "2.0", id, result };
}

export function errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcErrorResponse {
  const error: JsonRpcErrorObject = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

export type ParsedLine =
  | { kind: "request"; request: JsonRpcRequest }
  | { kind: "notification"; notification: JsonRpcNotification }
  /** Malformed input — `response` is the error the server must emit (or null for none). */
  | { kind: "invalid"; response: JsonRpcErrorResponse };

/**
 * Parse one wire line into a request / notification / invalid verdict.
 *
 * Rules implemented (matching JSON-RPC 2.0 + MCP stdio):
 * - Unparseable JSON               → PARSE_ERROR with `id: null`.
 * - JSON array (batch)             → INVALID_REQUEST (batching removed in MCP 2025-06-18).
 * - Non-object / missing `method`  → INVALID_REQUEST (echo `id` when recoverable).
 * - Object without `id`            → notification (never answered).
 */
export function parseLine(raw: string): ParsedLine {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: "invalid", response: errorResponse(null, PARSE_ERROR, "Parse error") };
  }

  if (Array.isArray(value)) {
    return {
      kind: "invalid",
      response: errorResponse(null, INVALID_REQUEST, "Invalid Request: batch messages are not supported"),
    };
  }

  if (value === null || typeof value !== "object") {
    return { kind: "invalid", response: errorResponse(null, INVALID_REQUEST, "Invalid Request") };
  }

  const msg = value as Record<string, unknown>;
  const id = extractId(msg);

  if (typeof msg.method !== "string" || msg.method.length === 0) {
    return { kind: "invalid", response: errorResponse(id, INVALID_REQUEST, "Invalid Request: missing method") };
  }

  const params =
    msg.params && typeof msg.params === "object" && !Array.isArray(msg.params)
      ? (msg.params as Record<string, unknown>)
      : undefined;

  if (!("id" in msg)) {
    return {
      kind: "notification",
      notification: { jsonrpc: "2.0", method: msg.method, params },
    };
  }

  return {
    kind: "request",
    request: { jsonrpc: "2.0", id, method: msg.method, params },
  };
}

function extractId(msg: Record<string, unknown>): JsonRpcId {
  const id = msg.id;
  if (typeof id === "string" || typeof id === "number") return id;
  return null;
}

export function serialize(response: JsonRpcResponse): string {
  return JSON.stringify(response);
}
