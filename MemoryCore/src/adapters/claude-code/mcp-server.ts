/**
 * TdaiMcpServer — Model Context Protocol server over stdio.
 *
 * Implements the MCP specification using JSON-RPC 2.0 over stdio transport.
 * Uses native Node.js `readline` for line-by-line stdin reading and
 * `process.stdout` for writing responses. No external MCP SDK dependency.
 *
 * Supported MCP methods:
 *
 *   - `initialize` — Returns server info and capabilities. Called once at
 *     connection startup. The client sends `notifications/initialized`
 *     afterwards to confirm.
 *   - `notifications/initialized` — Notification (no response) confirming
 *     the client has completed initialization.
 *   - `tools/list` — Returns the tool definitions from the adapter.
 *   - `tools/call` — Dispatches a tool invocation to
 *     `adapter.handleToolCall()`.
 *
 * JSON-RPC 2.0 message format:
 *
 *   Request:     { "jsonrpc": "2.0", "id": <number>, "method": "...", "params": {...} }
 *   Response:    { "jsonrpc": "2.0", "id": <number>, "result": {...} }
 *   Error:       { "jsonrpc": "2.0", "id": <number>, "error": { "code": <number>, "message": "..." } }
 *   Notification:{ "jsonrpc": "2.0", "method": "...", "params": {...} }  (no id, no response)
 *
 * All log output goes to stderr to avoid corrupting the JSON-RPC stream on
 * stdout.
 *
 * Usage:
 *   ```typescript
 *   const adapter = new ClaudeCodeAdapter();
 *   await adapter.initialize(adapter.resolveConfig());
 *
 *   const server = new TdaiMcpServer(adapter);
 *   server.start();
 *   ```
 */

import * as readline from "node:readline";
import type { ClaudeCodeAdapter } from "./adapter.js";
import type { ToolDefinition } from "../sdk/types.js";

// ============================
// Constants
// ============================

/** MCP protocol version supported by this server. */
const MCP_PROTOCOL_VERSION = "2024-11-05";

/** Server name reported in the `initialize` response. */
const SERVER_NAME = "tdai-memory-mcp";

/** Server version reported in the `initialize` response. */
const SERVER_VERSION = "1.0.0";

// ============================
// JSON-RPC 2.0 error codes
// ============================

/** Parse error — invalid JSON received. */
const ERROR_PARSE_ERROR = -32700;
/** Invalid request — the JSON is valid but not a valid JSON-RPC request. */
const ERROR_INVALID_REQUEST = -32600;
/** Method not found — the requested method does not exist. */
const ERROR_METHOD_NOT_FOUND = -32601;
/** Invalid params — method parameters are invalid. */
const ERROR_INVALID_PARAMS = -32602;
/** Internal error — unexpected server-side error. */
const ERROR_INTERNAL_ERROR = -32603;

// ============================
// JSON-RPC 2.0 type definitions
// ============================

/** A JSON-RPC 2.0 request or notification. */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  /** Request ID. Absent for notifications (no response expected). */
  id?: number | string | null;
  /** Method name. */
  method: string;
  /** Method parameters. */
  params?: unknown;
}

/** A JSON-RPC 2.0 successful response. */
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result: unknown;
}

/** A JSON-RPC 2.0 error response. */
interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** Content block in a tools/call response (MCP spec). */
interface McpContentBlock {
  type: "text";
  text: string;
}

/** Result of a tools/call method (MCP spec). */
interface McpCallToolResult {
  content: McpContentBlock[];
  isError?: boolean;
}

/** Tool definition in MCP format (for tools/list response). */
interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ============================
// TdaiMcpServer
// ============================

/**
 * MCP server that exposes TDAI memory tools to Claude Code via stdio.
 *
 * This server is transport-agnostic within the constraint of stdio: it
 * reads newline-delimited JSON-RPC messages from stdin and writes
 * JSON-RPC responses (one per line) to stdout. All diagnostic logging
 * goes to stderr.
 */
export class TdaiMcpServer {
  /** The adapter that handles tool calls. */
  private adapter: ClaudeCodeAdapter;

  /** The readline interface for reading stdin. */
  private rl: readline.Interface | null = null;

  /** Whether the server is currently running. */
  private running = false;

  /** Whether the client has completed the initialization handshake. */
  private initialized = false;

  /** Cached tool definitions (computed once from the adapter). */
  private toolDefs: McpToolDef[];

  /** Set of known tool names for fast lookup. */
  private toolNames: Set<string>;

  /**
   * @param adapter The configured and initialized ClaudeCodeAdapter.
   */
  constructor(adapter: ClaudeCodeAdapter) {
    this.adapter = adapter;
    this.toolDefs = this.buildToolDefs();
    this.toolNames = new Set(this.toolDefs.map((t) => t.name));
  }

  // ============================
  // Lifecycle
  // ============================

  /**
   * Start the MCP server.
   *
   * Creates a readline interface on stdin and begins processing
   * JSON-RPC messages. The server runs until stdin is closed or
   * {@link stop} is called.
   */
  start(): void {
    if (this.running) {
      process.stderr.write("[tdai:mcp] Server already running\n");
      return;
    }

    this.running = true;

    // Create readline interface for line-by-line stdin reading.
    // CRITICAL: stdin must not be in raw mode — JSON-RPC messages are
    // newline-delimited text.
    this.rl = readline.createInterface({
      input: process.stdin,
      output: undefined, // We write responses manually to avoid echo
      crlfDelay: Infinity, // Handle both \n and \r\n line endings
    });

    process.stderr.write(
      `[tdai:mcp] Server started — ${this.toolDefs.length} tools registered: ` +
        `${this.toolDefs.map((t) => t.name).join(", ")}\n`,
    );

    this.rl.on("line", (line: string) => {
      this.handleLine(line).catch((err) => {
        process.stderr.write(
          `[tdai:mcp] Unhandled error in message handler: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      });
    });

    this.rl.on("close", () => {
      process.stderr.write("[tdai:mcp] stdin closed, shutting down\n");
      this.running = false;
      // Exit gracefully — the parent process (Claude Code) has disconnected
      process.exit(0);
    });

    this.rl.on("error", (err: Error) => {
      process.stderr.write(`[tdai:mcp] readline error: ${err.message}\n`);
    });
  }

  /**
   * Stop the MCP server.
   *
   * Closes the readline interface and marks the server as not running.
   * Safe to call multiple times.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    process.stderr.write("[tdai:mcp] Server stopped\n");
  }

  // ============================
  // Message handling
  // ============================

  /**
   * Handle a single line of input (one JSON-RPC message).
   *
   * Parses the JSON, dispatches to the appropriate method handler, and
   * writes the response to stdout. Notifications (messages without an `id`)
   * do not receive a response.
   */
  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Parse the JSON-RPC message
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      // JSON parse error — send error response with null id
      this.sendError(null, ERROR_PARSE_ERROR, "Parse error: invalid JSON");
      return;
    }

    // Validate basic JSON-RPC 2.0 structure
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      this.sendError(
        message.id ?? null,
        ERROR_INVALID_REQUEST,
        "Invalid request: missing jsonrpc version or method",
      );
      return;
    }

    const { id, method, params } = message;

    // Notifications (no id) — handle silently, no response
    if (id === undefined || id === null) {
      await this.handleNotification(method, params);
      return;
    }

    // Requests (with id) — must send a response
    try {
      const result = await this.handleMethod(method, params);
      this.sendResponse(id, result);
    } catch (err) {
      const code = err instanceof RpcError ? err.code : ERROR_INTERNAL_ERROR;
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[tdai:mcp] Method "${method}" failed: ${msg}\n`);
      this.sendError(id, code, msg);
    }
  }

  /**
   * Handle a JSON-RPC notification (message without an id).
   *
   * Notifications do not receive responses.
   */
  private async handleNotification(
    method: string,
    params: unknown,
  ): Promise<void> {
    switch (method) {
      case "notifications/initialized":
        this.initialized = true;
        process.stderr.write("[tdai:mcp] Client initialized notification received\n");
        break;

      case "notifications/cancelled":
        // A request was cancelled by the client — log and ignore.
        process.stderr.write("[tdai:mcp] Request cancelled by client\n");
        break;

      default:
        process.stderr.write(`[tdai:mcp] Unknown notification: ${method}\n`);
        break;
    }
  }

  /**
   * Handle a JSON-RPC request (message with an id).
   *
   * @returns The result object to include in the response.
   * @throws {RpcError} For known error conditions.
   */
  private async handleMethod(
    method: string,
    params: unknown,
  ): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.handleInitialize(params);

      case "tools/list":
        return this.handleToolsList();

      case "tools/call":
        return await this.handleToolsCall(params);

      case "ping":
        // Simple keepalive — return empty result
        return {};

      default:
        throw new RpcError(
          ERROR_METHOD_NOT_FOUND,
          `Method not found: ${method}`,
        );
    }
  }

  // ============================
  // MCP method handlers
  // ============================

  /**
   * Handle the `initialize` method.
   *
   * Returns server info and capabilities. The client must call
   * `notifications/initialized` afterwards to complete the handshake.
   *
   * @returns MCP initialize result with server info and capabilities.
   */
  private handleInitialize(_params: unknown): {
    protocolVersion: string;
    capabilities: Record<string, unknown>;
    serverInfo: { name: string; version: string };
  } {
    return {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
    };
  }

  /**
   * Handle the `tools/list` method.
   *
   * Returns the tool definitions registered by the adapter.
   *
   * @returns MCP tools/list result with tool definitions.
   */
  private handleToolsList(): { tools: McpToolDef[] } {
    return { tools: this.toolDefs };
  }

  /**
   * Handle the `tools/call` method.
   *
   * Dispatches the tool call to `adapter.handleToolCall()` and wraps
   * the result in the MCP content block format.
   *
   * @returns MCP tools/call result with content blocks.
   * @throws {RpcError} If the tool name is unknown or params are invalid.
   */
  private async handleToolsCall(params: unknown): Promise<McpCallToolResult> {
    if (!params || typeof params !== "object") {
      throw new RpcError(ERROR_INVALID_PARAMS, "Missing or invalid params");
    }

    const { name, arguments: args } = params as {
      name?: string;
      arguments?: Record<string, unknown>;
    };

    if (!name || typeof name !== "string") {
      throw new RpcError(ERROR_INVALID_PARAMS, "Missing or invalid 'name' parameter");
    }

    if (!this.toolNames.has(name)) {
      throw new RpcError(
        ERROR_METHOD_NOT_FOUND,
        `Unknown tool: ${name}. Available tools: ${[...this.toolNames].join(", ")}`,
      );
    }

    const toolArgs = args ?? {};

    process.stderr.write(
      `[tdai:mcp] Tool call: ${name}(${JSON.stringify(toolArgs)})\n`,
    );

    try {
      const resultText = await this.adapter.handleToolCall(name, toolArgs);

      return {
        content: [{ type: "text", text: resultText }],
        isError: false,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[tdai:mcp] Tool "${name}" failed: ${errorMsg}\n`);

      return {
        content: [{ type: "text", text: `Error: ${errorMsg}` }],
        isError: true,
      };
    }
  }

  // ============================
  // Output helpers
  // ============================

  /**
   * Send a successful JSON-RPC response to stdout.
   */
  private sendResponse(id: number | string | null, result: unknown): void {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id,
      result,
    };
    this.writeLine(JSON.stringify(response));
  }

  /**
   * Send a JSON-RPC error response to stdout.
   */
  private sendError(
    id: number | string | null,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    const response: JsonRpcErrorResponse = {
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    };
    this.writeLine(JSON.stringify(response));
  }

  /**
   * Write a single line to stdout followed by a newline.
   *
   * Uses synchronous write to ensure message ordering. The MCP spec
   * requires newline-delimited JSON.
   */
  private writeLine(data: string): void {
    process.stdout.write(data + "\n");
  }

  // ============================
  // Tool definition builder
  // ============================

  /**
   * Build MCP-format tool definitions from the adapter's tool definitions.
   *
   * Maps the SDK's `ToolDefinition` (with `parameters`) to the MCP format
   * (with `inputSchema`).
   */
  private buildToolDefs(): McpToolDef[] {
    const tools = this.adapter.getToolDefinitions();

    return tools.map((tool: ToolDefinition): McpToolDef => {
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: {
          type: "object",
          properties: tool.parameters.properties,
          required: tool.parameters.required ?? [],
        },
      };
    });
  }
}

// ============================
// RpcError — typed JSON-RPC error
// ============================

/**
 * Custom error class for JSON-RPC error responses.
 *
 * Carries a numeric error code following the JSON-RPC 2.0 spec,
 * allowing the server to send structured error responses.
 */
class RpcError extends Error {
  /** JSON-RPC error code. */
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}
