/**
 * TDAI Memory MCP Server — exposes the TDAI Gateway as a Model Context
 * Protocol server over stdio transport.
 *
 * ─── Architecture ──────────────────────────────────────────────────────────
 *
 *   MCP Client (Codex, Claude Code, Cursor, etc.)
 *           │  MCP over STDIO (JSON-RPC 2.0)
 *           ▼
 *   TdaiMcpServer (this file)
 *     ┌──────────────────────┐
 *     │ Protocol validation  │
 *     │ Tool schemas         │
 *     │ Input sanitization   │
 *     └──────┬───────────────┘
 *            │ HTTP
 *            ▼
 *   GatewayMemoryClient → TDAI Gateway → TdaiCore
 *
 * ─── Tools ─────────────────────────────────────────────────────────────────
 *
 *   | Tool                    | Purpose                                |
 *   |-------------------------|----------------------------------------|
 *   | tdai_recall             | Return L1 memories + persona context   |
 *   | tdai_memory_search      | Search structured L1 memory            |
 *   | tdai_conversation_search| Search raw L0 conversation history     |
 *   | tdai_capture            | Persist a completed user/assistant turn|
 *   | tdai_session_end        | Flush pending work for a session       |
 *
 * ─── Protocol ──────────────────────────────────────────────────────────────
 *
 *   Implements MCP revisions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05
 *   JSON-RPC 2.0 over stdin/stdout.
 *   STDOUT is reserved for newline-delimited JSON-RPC frames.
 *   Fatal startup diagnostics go to STDERR.
 *
 * @see https://spec.modelcontextprotocol.io/ — MCP specification
 */

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { GatewayMemoryClient } from "../gateway-client/index.js";

const TAG = "[tdai-mcp]";

// ============================
// Constants
// ============================

/** Supported MCP protocol versions, newest first. */
const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

const CURRENT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const SERVER_NAME = "memory-tdai";
const SERVER_VERSION = "0.3.0";
const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8420";

// ============================
// JSON-RPC types
// ============================

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const ErrorCode = {
  // JSON-RPC standard
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // MCP specific
  NotInitialized: -32002,
  ToolError: -32003,
} as const;

// ============================
// Tool schemas (closed — additionalProperties: false)
// ============================

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "tdai_recall",
    description:
      "Recall relevant memories and persona context for the current conversation. " +
      "Call this before generating a response to inject memory context into the prompt. " +
      "Returns prepend_context (per-turn L1 memories) and append_system_context (stable persona/scene guidance). " +
      "The host should inject prepend_context before the user message and append_system_context into the system prompt.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The user's current message or query" },
        session_key: { type: "string", description: "Stable session identifier for memory scoping" },
      },
      required: ["query", "session_key"],
      additionalProperties: false,
    },
  },
  {
    name: "tdai_memory_search",
    description:
      "Search through the user's long-term structured memories (L1). " +
      "Use this when you need to recall specific facts, preferences, or past events. " +
      "Results are relevance-ranked.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default: 5, max: 20)", default: 5 },
        type: {
          type: "string",
          enum: ["persona", "episodic", "instruction"],
          description: "Optional memory type filter",
        },
        scene: { type: "string", description: "Optional scene/session filter" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "tdai_conversation_search",
    description:
      "Search through raw conversation history (L0). " +
      "Use this when you need to find exact dialogue from past conversations " +
      "that may not have been extracted into structured memories yet.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default: 5, max: 20)", default: 5 },
        session_key: { type: "string", description: "Optional session filter" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "tdai_capture",
    description:
      "Persist a completed user/assistant conversation turn to memory. " +
      "Call this after each assistant response to record the conversation " +
      "for future recall. The Gateway handles L0 recording and L1/L2/L3 extraction.",
    inputSchema: {
      type: "object",
      properties: {
        user_content: { type: "string", description: "The user's message text" },
        assistant_content: { type: "string", description: "The assistant's response text" },
        session_key: { type: "string", description: "Stable session identifier" },
        session_id: { type: "string", description: "Optional sub-session or run ID" },
      },
      required: ["user_content", "assistant_content", "session_key"],
      additionalProperties: false,
    },
  },
  {
    name: "tdai_session_end",
    description:
      "End an active session and flush any buffered state. " +
      "Call this when a conversation or task completes to ensure " +
      "all pending memory extraction work is scheduled.",
    inputSchema: {
      type: "object",
      properties: {
        session_key: { type: "string", description: "Session identifier to end" },
      },
      required: ["session_key"],
      additionalProperties: false,
    },
  },
];

// Build a lookup map for O(1) tool dispatch.
const TOOL_MAP = new Map<string, ToolDefinition>();
for (const tool of TOOL_DEFINITIONS) {
  TOOL_MAP.set(tool.name, tool);
}

// ============================
// TdaiMcpServer
// ============================

export class TdaiMcpServer {
  private client: GatewayMemoryClient;
  private initialized = false;
  private stopped = false;

  /**
   * Optional output collector for tests. When set, responses go here
   * instead of stdout. Undefined in production.
   */
  testOutputs: JsonRpcResponse[] | undefined;

  constructor(client: GatewayMemoryClient) {
    this.client = client;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Process a single JSON-RPC message line.
   * Public for testing via processLine(). In production, use start().
   *
   * @returns The JSON-RPC response, or null for notifications.
   */
  async handleLine(line: string): Promise<JsonRpcResponse | null> {
    if (!line.trim()) return null;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      return this.sendError(null, ErrorCode.ParseError, "Parse error");
    }

    return this.handleRequest(request);
  }

  /**
   * Start the MCP server: read JSON-RPC messages from stdin and
   * write responses to stdout. Runs until stdin closes.
   */
  async start(input?: Readable, output?: Writable): Promise<void> {
    const stdin = input ?? process.stdin;
    const stdout = output ?? process.stdout;

    console.error(`${TAG} MCP server starting (gateway=${this.client.baseUrl})...`);

    const rl = createInterface({ input: stdin, terminal: false, crlfDelay: Infinity });

    for await (const line of rl) {
      const response = await this.handleLine(line);
      if (response) {
        this.writeResponse(response, stdout);
      }
    }

    console.error(`${TAG} stdin closed, shutting down...`);
  }

  // ── Request handling ─────────────────────────────────────────────────────

  private async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    // Validate JSON-RPC 2.0
    if (request.jsonrpc !== "2.0") {
      return this.sendError(request.id ?? null, ErrorCode.InvalidRequest, "Must use jsonrpc 2.0");
    }

    // Validate request ID
    if (request.id !== undefined && request.id !== null) {
      if (typeof request.id === "number" && !Number.isInteger(request.id)) {
        return this.sendError(null, ErrorCode.InvalidRequest, "Request ID must be an integer or string");
      }
      if (typeof request.id === "boolean" || typeof request.id === "object") {
        return this.sendError(null, ErrorCode.InvalidRequest, "Invalid request ID type");
      }
    }

    // Notifications (no id) — no response expected
    if (request.id === undefined || request.id === null) {
      this.handleNotification(request);
      return null;
    }

    // Dispatch by method
    switch (request.method) {
      case "initialize":
        return this.handleInitialize(request);

      case "notifications/initialized":
        // Already handled via handleNotification, but defensively handle here too
        this.initialized = true;
        return null;

      case "tools/list":
        return this.sendResponse(request.id, { tools: TOOL_DEFINITIONS });

      case "tools/call":
        return this.handleToolCall(request);

      default:
        return this.sendError(request.id, ErrorCode.MethodNotFound, `Unknown method: ${request.method}`);
    }
  }

  private handleNotification(request: JsonRpcRequest): void {
    if (request.method === "notifications/initialized") {
      this.initialized = true;
      console.error(`${TAG} Client initialized`);
    }
    // Other notifications are silently ignored per JSON-RPC spec
  }

  // ── Initialize ───────────────────────────────────────────────────────────

  private handleInitialize(request: JsonRpcRequest): JsonRpcResponse {
    const clientVersion = (request.params?.protocolVersion as string) ?? "";

    // Negotiate protocol version: find the highest server version
    // that the client version supports (v <= clientVersion).
    const negotiated = SUPPORTED_PROTOCOL_VERSIONS.find(
      (v) => v <= clientVersion,
    ) ?? CURRENT_PROTOCOL_VERSION;

    console.error(`${TAG} Initialize: client=${clientVersion} → negotiated=${negotiated}`);

    return this.sendResponse(request.id!, {
      protocolVersion: negotiated,
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
    });
  }

  // ── tools/call ───────────────────────────────────────────────────────────

  private async handleToolCall(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const name = request.params?.name as string | undefined;
    const args = request.params?.arguments as Record<string, unknown> | undefined;

    if (!name) {
      return this.sendError(request.id!, ErrorCode.InvalidParams, "Missing required parameter: name");
    }
    if (!args) {
      return this.sendError(request.id!, ErrorCode.InvalidParams, "Missing required parameter: arguments");
    }

    // Validate tool exists and check for extra arguments
    const toolDef = TOOL_MAP.get(name);
    if (!toolDef) {
      return this.sendError(request.id!, ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }

    // Reject extra arguments not in the schema (closed schema enforcement)
    const schema = toolDef.inputSchema as Record<string, unknown>;
    const properties = (schema.properties as Record<string, unknown>) ?? {};
    for (const key of Object.keys(args)) {
      if (!(key in properties)) {
        return this.sendError(
          request.id!,
          ErrorCode.InvalidParams,
          `Unexpected argument: ${key}`,
        );
      }
    }

    // Validate required args
    const required = (schema.required as string[]) ?? [];
    for (const key of required) {
      if (args[key] === undefined || args[key] === null) {
        return this.sendError(
          request.id!,
          ErrorCode.InvalidParams,
          `Missing required argument: ${key}`,
        );
      }
    }

    // If not initialized, require initialize first (unless it's an initialize request)
    if (!this.initialized) {
      return this.sendError(request.id!, ErrorCode.NotInitialized, "Server not initialized");
    }

    try {
      return await this.dispatchTool(request.id!, name, args);
    } catch (err) {
      console.error(`${TAG} Tool ${name} error: ${err}`);
      return this.sendToolError(request.id!, name, err);
    }
  }

  private async dispatchTool(
    id: number | string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    switch (name) {
      case "tdai_recall": {
        const result = await this.client.recall({
          query: String(args.query),
          session_key: String(args.session_key),
        });
        return this.sendResponse(id, {
          content: [{ type: "text", text: result.context ?? "" }],
          structuredContent: {
            prepend_context: result.context,
            strategy: result.strategy,
          },
        });
      }

      case "tdai_memory_search": {
        const searchResult = await this.client.searchMemories({
          query: String(args.query),
          limit: clampLimit(args.limit),
          type: typeof args.type === "string" ? args.type : undefined,
          scene: typeof args.scene === "string" ? args.scene : undefined,
        });
        return this.sendResponse(id, {
          content: [{ type: "text", text: searchResult.results || "No memories found." }],
        });
      }

      case "tdai_conversation_search": {
        const convResult = await this.client.searchConversations({
          query: String(args.query),
          limit: clampLimit(args.limit),
          session_key: typeof args.session_key === "string" ? args.session_key : undefined,
        });
        return this.sendResponse(id, {
          content: [{ type: "text", text: convResult.results || "No conversation records found." }],
        });
      }

      case "tdai_capture": {
        const captureResult = await this.client.capture({
          user_content: String(args.user_content),
          assistant_content: String(args.assistant_content),
          session_key: String(args.session_key),
          session_id: typeof args.session_id === "string" ? args.session_id : undefined,
        });
        return this.sendResponse(id, {
          content: [{ type: "text", text: `Captured: ${captureResult.l0_recorded} turn(s)` }],
        });
      }

      case "tdai_session_end": {
        const endResult = await this.client.endSession({
          session_key: String(args.session_key),
        });
        return this.sendResponse(id, {
          content: [{ type: "text", text: `Session ended (flushed: ${endResult.flushed})` }],
        });
      }

      default:
        return this.sendError(id, ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }
  }

  // ── Response helpers ─────────────────────────────────────────────────────

  private sendResponse(id: number | string, result: unknown): JsonRpcResponse {
    const msg: JsonRpcResponse = { jsonrpc: "2.0", id, result };
    return msg;
  }

  private sendError(id: number | string | null, code: number, message: string, data?: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id: id ?? 0, error: { code, message, data } };
  }

  private sendToolError(id: number | string, toolName: string, err: unknown): JsonRpcResponse {
    const message = err instanceof Error ? err.message : String(err);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: `Error executing ${toolName}: ${message}` }],
        isError: true,
      },
    };
  }

  private writeResponse(msg: JsonRpcResponse, stdout: Writable): void {
    if (this.testOutputs) {
      this.testOutputs.push(msg);
      return;
    }
    try {
      stdout.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      console.error(`${TAG} Failed to write response: ${err}`);
    }
  }
}

// ============================
// Factory helpers
// ============================

export interface McpServerOptions {
  gatewayUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  /**
   * Custom fetch implementation for testing.
   * Defaults to global fetch.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Create an MCP server from environment configuration or explicit options.
 *
 * Environment variables:
 * - `TDAI_GATEWAY_URL` — Gateway base URL (default: http://127.0.0.1:8420)
 * - `TDAI_GATEWAY_API_KEY` — Gateway API key (optional)
 * - `TDAI_GATEWAY_TIMEOUT_MS` — Request timeout in ms (default: 10000)
 */
export function createMcpServer(
  opts?: McpServerOptions,
): TdaiMcpServer {
  const gatewayUrl = opts?.gatewayUrl
    ?? process.env.TDAI_GATEWAY_URL
    ?? DEFAULT_GATEWAY_URL;

  const apiKey = opts?.apiKey ?? process.env.TDAI_GATEWAY_API_KEY;

  const timeoutMs = opts?.timeoutMs
    ?? (process.env.TDAI_GATEWAY_TIMEOUT_MS
      ? safeParseInt(process.env.TDAI_GATEWAY_TIMEOUT_MS, 10_000)
      : 10_000);

  const client = new GatewayMemoryClient({
    baseUrl: gatewayUrl,
    apiKey,
    timeoutMs,
    fetchImpl: opts?.fetchImpl,
  });

  return new TdaiMcpServer(client);
}

// ============================
// Utilities
// ============================

function clampLimit(limit: unknown): number | undefined {
  if (limit === undefined || limit === null) return undefined;
  const n = Number(limit);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(Math.max(Math.round(n), 1), 20);
}

function safeParseInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
