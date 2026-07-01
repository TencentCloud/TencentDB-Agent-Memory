import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import {
  GatewayRequestError,
  TdaiGatewayClient,
  type GatewayClientOptions,
} from "./gateway-client.js";

const SERVER_NAME = "memory-tencentdb";
const SERVER_VERSION = "0.3.6";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface GatewayOperations {
  recall(request: { query: string; session_key: string }): Promise<unknown>;
  capture(request: {
    user_content: string;
    assistant_content: string;
    session_key: string;
    session_id?: string;
  }): Promise<unknown>;
  searchMemories(request: {
    query: string;
    limit?: number;
    type?: string;
    scene?: string;
  }): Promise<unknown>;
  searchConversations(request: {
    query: string;
    limit?: number;
    session_key?: string;
  }): Promise<unknown>;
  endSession(request: { session_key: string }): Promise<unknown>;
}

const TOOLS = [
  {
    name: "tdai_recall",
    description:
      "Recall memory context for the current task. Returns dynamic L1 context separately from stable persona/scene context so the client can place each correctly.",
    inputSchema: objectSchema({
      query: stringProperty("Current user request or a concise recall query"),
      session_key: stringProperty("Stable session key used to scope memory"),
    }, ["query", "session_key"]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "tdai_capture",
    description:
      "Capture one completed user/assistant turn into TencentDB Agent Memory.",
    inputSchema: objectSchema({
      user_content: stringProperty("User message to persist"),
      assistant_content: stringProperty("Assistant response to persist"),
      session_key: stringProperty("Stable session key used to scope memory"),
      session_id: stringProperty("Optional concrete conversation instance ID"),
    }, ["user_content", "assistant_content", "session_key"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "tdai_memory_search",
    description: "Search structured long-term memories (L1) by keyword or meaning.",
    inputSchema: objectSchema({
      query: stringProperty("Search query"),
      limit: integerProperty("Maximum results", 1, 50),
      type: stringProperty("Optional memory type filter"),
      scene: stringProperty("Optional scene filter"),
    }, ["query"]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "tdai_conversation_search",
    description: "Search raw conversation history (L0) for exact details and source context.",
    inputSchema: objectSchema({
      query: stringProperty("Search query"),
      limit: integerProperty("Maximum results", 1, 50),
      session_key: stringProperty("Optional session scope"),
    }, ["query"]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "tdai_session_end",
    description: "Flush pending memory pipeline work for a completed session.",
    inputSchema: objectSchema({
      session_key: stringProperty("Session key to flush"),
    }, ["session_key"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
] as const;

export class TdaiMcpServer {
  constructor(private readonly gateway: GatewayOperations) {}

  async handle(request: unknown): Promise<Record<string, unknown> | undefined> {
    const parsed = parseRequest(request);
    if (!parsed.ok) return errorResponse(null, -32600, parsed.message);
    const rpc = parsed.value;

    // Notifications deliberately have no response.
    if (rpc.id === undefined) return undefined;

    try {
      switch (rpc.method) {
        case "initialize":
          return successResponse(rpc.id, initializeResult(rpc.params));
        case "ping":
          return successResponse(rpc.id, {});
        case "tools/list":
          return successResponse(rpc.id, { tools: TOOLS });
        case "tools/call":
          return successResponse(rpc.id, await this.callTool(rpc.params));
        default:
          return errorResponse(rpc.id, -32601, `Method not found: ${rpc.method}`);
      }
    } catch (error) {
      if (error instanceof InvalidParamsError) {
        return errorResponse(rpc.id, -32602, error.message);
      }
      return errorResponse(
        rpc.id,
        -32603,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async callTool(params: unknown): Promise<Record<string, unknown>> {
    const value = requireRecord(params, "tools/call params");
    const name = requireString(value.name, "name");
    const args = value.arguments === undefined
      ? {}
      : requireRecord(value.arguments, "arguments");

    try {
      let result: unknown;
      switch (name) {
        case "tdai_recall":
          result = await this.gateway.recall({
            query: requireString(args.query, "query"),
            session_key: requireString(args.session_key, "session_key"),
          });
          break;
        case "tdai_capture":
          result = await this.gateway.capture({
            user_content: requireString(args.user_content, "user_content"),
            assistant_content: requireString(args.assistant_content, "assistant_content"),
            session_key: requireString(args.session_key, "session_key"),
            ...optionalString(args, "session_id"),
          });
          break;
        case "tdai_memory_search":
          result = await this.gateway.searchMemories({
            query: requireString(args.query, "query"),
            ...optionalLimit(args.limit),
            ...optionalString(args, "type"),
            ...optionalString(args, "scene"),
          });
          break;
        case "tdai_conversation_search":
          result = await this.gateway.searchConversations({
            query: requireString(args.query, "query"),
            ...optionalLimit(args.limit),
            ...optionalString(args, "session_key"),
          });
          break;
        case "tdai_session_end":
          result = await this.gateway.endSession({
            session_key: requireString(args.session_key, "session_key"),
          });
          break;
        default:
          throw new InvalidParamsError(`Unknown tool: ${name}`);
      }
      return toolResult(result, false);
    } catch (error) {
      if (error instanceof InvalidParamsError) throw error;
      const message = error instanceof GatewayRequestError
        ? error.message
        : `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`;
      return toolResult({ error: message }, true);
    }
  }
}

export async function runStdioMcpServer(
  server: TdaiMcpServer,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request: unknown;
    try {
      request = JSON.parse(line) as unknown;
    } catch {
      output.write(`${JSON.stringify(errorResponse(null, -32700, "Parse error"))}\n`);
      continue;
    }
    const response = await server.handle(request);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}

export function createMcpServerFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: { fetchImpl?: typeof fetch } = {},
): TdaiMcpServer {
  const gatewayOptions: GatewayClientOptions = {
    baseUrl: env.TDAI_GATEWAY_URL?.trim() || "http://127.0.0.1:8787",
    apiKey: env.TDAI_GATEWAY_API_KEY,
    timeoutMs: parsePositiveInteger(env.TDAI_GATEWAY_TIMEOUT_MS),
    fetchImpl: options.fetchImpl,
  };
  return new TdaiMcpServer(new TdaiGatewayClient(gatewayOptions));
}

function initializeResult(params: unknown): Record<string, unknown> {
  const value = params && typeof params === "object" && !Array.isArray(params)
    ? params as Record<string, unknown>
    : {};
  const requested = typeof value.protocolVersion === "string"
    ? value.protocolVersion
    : DEFAULT_PROTOCOL_VERSION;
  return {
    protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requested)
      ? requested
      : DEFAULT_PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions:
      "Use tdai_recall before work that benefits from prior context. Use search tools for deeper lookup. Capture a completed turn only when durable memory is appropriate.",
  };
}

function parseRequest(value: unknown):
  | { ok: true; value: JsonRpcRequest }
  | { ok: false; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "Invalid Request" };
  }
  const request = value as Record<string, unknown>;
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return { ok: false, message: "Invalid Request" };
  }
  if (
    request.id !== undefined &&
    request.id !== null &&
    typeof request.id !== "string" &&
    typeof request.id !== "number"
  ) {
    return { ok: false, message: "Invalid Request" };
  }
  return { ok: true, value: request as unknown as JsonRpcRequest };
}

function successResponse(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolResult(value: unknown, isError: boolean): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

class InvalidParamsError extends Error {}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidParamsError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new InvalidParamsError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): Record<string, string> {
  if (args[key] === undefined) return {};
  return { [key]: requireString(args[key], key) };
}

function optionalLimit(value: unknown): { limit?: number } {
  if (value === undefined) return {};
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 50) {
    throw new InvalidParamsError("limit must be an integer between 1 and 50");
  }
  return { limit: value as number };
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("TDAI_GATEWAY_TIMEOUT_MS must be a positive integer");
  }
  return parsed;
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function stringProperty(description: string): Record<string, unknown> {
  return { type: "string", minLength: 1, description };
}

function integerProperty(
  description: string,
  minimum: number,
  maximum: number,
): Record<string, unknown> {
  return { type: "integer", minimum, maximum, description };
}
