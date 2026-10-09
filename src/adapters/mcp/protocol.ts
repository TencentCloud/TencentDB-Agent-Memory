/**
 * MCP protocol core — a dependency-free JSON-RPC 2.0 dispatcher that maps
 * Model Context Protocol requests onto the SDK's neutral memory tools.
 *
 * This file contains NO I/O: it takes a decoded JSON-RPC request and returns
 * a JSON-RPC response object (or `null` for notifications). `server.ts` owns
 * the stdio transport. Keeping the two apart makes the whole protocol layer
 * unit-testable without spawning a process.
 *
 * Implemented MCP methods:
 *   - `initialize`                 → capabilities + serverInfo (version negotiated)
 *   - `notifications/initialized`  → no response (notification)
 *   - `ping`                       → {}
 *   - `tools/list`                 → the memory tools
 *   - `tools/call`                 → invoke a tool, return `content` + `isError`
 *
 * We deliberately implement only the tools capability — that is all the memory
 * adapter needs, and it is what Claude Code, Codex, Cursor, and Cline consume.
 */

import type { MemoryTool } from "../../sdk/tools.js";

// ============================
// JSON-RPC 2.0 types
// ============================

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

/** Standard JSON-RPC + MCP error codes. */
export const RpcErr = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

// ============================
// MCP version negotiation
// ============================

/** Protocol revisions this server understands, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

function negotiateVersion(requested: unknown): string {
  if (typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    return requested;
  }
  return LATEST_PROTOCOL_VERSION;
}

// ============================
// Dispatcher
// ============================

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpDispatcherOptions {
  tools: MemoryTool[];
  serverInfo: McpServerInfo;
  /** Optional instructions surfaced to the host during `initialize`. */
  instructions?: string;
  logger?: (message: string) => void;
}

export class McpDispatcher {
  private readonly toolsByName: Map<string, MemoryTool>;
  private readonly tools: MemoryTool[];
  private readonly serverInfo: McpServerInfo;
  private readonly instructions?: string;
  private readonly log: (message: string) => void;

  constructor(opts: McpDispatcherOptions) {
    this.tools = opts.tools;
    this.toolsByName = new Map(opts.tools.map((t) => [t.name, t]));
    this.serverInfo = opts.serverInfo;
    this.instructions = opts.instructions;
    this.log = opts.logger ?? (() => {});
  }

  /**
   * Handle one decoded JSON-RPC request.
   *
   * Returns a response object, or `null` when the message is a notification
   * (no `id`) and therefore must not be answered.
   */
  async handle(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const isNotification = req.id === undefined;

    // Validate envelope. Notifications get no error reply per JSON-RPC.
    if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      if (isNotification) return null;
      return this.error(req.id ?? null, RpcErr.InvalidRequest, "Invalid JSON-RPC request");
    }

    // Notifications: process side effects (none needed today) and stay silent.
    if (isNotification) {
      this.log(`notification: ${req.method}`);
      return null;
    }

    const id = req.id ?? null;
    try {
      switch (req.method) {
        case "initialize":
          return this.ok(id, this.handleInitialize(req.params));
        case "ping":
          return this.ok(id, {});
        case "tools/list":
          return this.ok(id, { tools: this.listTools() });
        case "tools/call":
          return this.ok(id, await this.callTool(req.params));
        default:
          return this.error(id, RpcErr.MethodNotFound, `Method not found: ${req.method}`);
      }
    } catch (err) {
      if (err instanceof RpcInvalidParams) {
        return this.error(id, RpcErr.InvalidParams, err.message);
      }
      const message = err instanceof Error ? err.message : String(err);
      this.log(`internal error handling ${req.method}: ${message}`);
      return this.error(id, RpcErr.InternalError, message);
    }
  }

  // -- Method implementations ----------------------------------------------

  private handleInitialize(params: unknown): unknown {
    const p = (params ?? {}) as { protocolVersion?: unknown };
    return {
      protocolVersion: negotiateVersion(p.protocolVersion),
      capabilities: { tools: { listChanged: false } },
      serverInfo: this.serverInfo,
      ...(this.instructions ? { instructions: this.instructions } : {}),
    };
  }

  private listTools(): unknown[] {
    return this.tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  private async callTool(params: unknown): Promise<unknown> {
    const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
    if (typeof p.name !== "string" || !p.name) {
      throw new RpcInvalidParams("tools/call requires a string 'name'");
    }
    const tool = this.toolsByName.get(p.name);
    if (!tool) {
      throw new RpcInvalidParams(`Unknown tool: ${p.name}`);
    }
    const args =
      p.arguments && typeof p.arguments === "object" && !Array.isArray(p.arguments)
        ? (p.arguments as Record<string, unknown>)
        : {};

    this.log(`tools/call ${p.name}`);
    // `invoke` is contractually non-throwing, but guard anyway so a bug in a
    // tool surfaces as an MCP tool error (visible to the model) rather than a
    // transport-level JSON-RPC error.
    let result;
    try {
      result = await tool.invoke(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = { text: message, isError: true as const };
    }

    return {
      content: [{ type: "text", text: result.text }],
      isError: result.isError ?? false,
    };
  }

  // -- Response builders ---------------------------------------------------

  private ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, result };
  }

  private error(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }
}

/** Thrown by method handlers to produce a JSON-RPC -32602 (Invalid params). */
class RpcInvalidParams extends Error {}
