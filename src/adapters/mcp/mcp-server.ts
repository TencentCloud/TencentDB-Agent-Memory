/**
 * MCP server adapter for Claude Code (issue #3 — 深入).
 *
 * Exposes TDAI memory tools over the Model Context Protocol (stdio JSON-RPC
 * 2.0), so Claude Code (or any MCP-capable client) can search memories, search
 * conversations, recall context, and capture turns.
 *
 * The server itself is transport-thin: it parses JSON-RPC requests and
 * delegates every memory operation to an injected {@link MemoryAdapter}. That
 * means the same MCP server works whether the memory backend is the HTTP
 * Gateway (`HttpMemoryAdapter`) or an in-process `TdaiCore`
 * (`InProcessMemoryAdapter`) — the platform picks the transport at startup.
 *
 * Protocol coverage (the subset a Claude Code client uses):
 *   - `initialize`                      → server info + `tools` capability
 *   - `notifications/initialized`       → notification, no response
 *   - `tools/list`                      → the four memory tools + schemas
 *   - `tools/call`                      → dispatch to the adapter
 *
 * The JSON-RPC dispatcher (`handleJsonRpc`) is a pure function with no I/O, so
 * it can be unit-tested directly; the stdio loop (`runStdio`) only wires
 * stdin/stdout.
 */

import type { Readable, Writable } from "node:stream";
import type { MemoryAdapter } from "../sdk/types.js";
import { MemoryAdapterError } from "../sdk/types.js";

// ──────────────────────────────────────────────────────────────────────────
// Protocol types
// ──────────────────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcInbound = JsonRpcRequest | JsonRpcNotification;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ──────────────────────────────────────────────────────────────────────────
// Tool catalogue
// ──────────────────────────────────────────────────────────────────────────

const TOOLS: ToolDef[] = [
  {
    name: "tdai_memory_search",
    description:
      "Search structured L1 memories (persona / episodic / instruction) about the user. " +
      "Prefer this over conversation search for stable facts and preferences.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to recall about the user" },
        limit: { type: "number", description: "Max results (default 5, max 20)" },
        type: { type: "string", enum: ["persona", "episodic", "instruction"] },
        scene: { type: "string", description: "Optional scene filter" },
      },
      required: ["query"],
    },
  },
  {
    name: "tdai_conversation_search",
    description:
      "Search raw L0 conversation messages when structured memories don't have what you need.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Max messages (default 5, max 20)" },
        session_key: { type: "string", description: "Optional session filter" },
      },
      required: ["query"],
    },
  },
  {
    name: "tdai_recall",
    description:
      "Recall relevant memories for a user query and return context to inject into the turn. " +
      "Use at the start of a turn (before generating a reply).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        session_key: { type: "string" },
      },
      required: ["query", "session_key"],
    },
  },
  {
    name: "tdai_capture",
    description:
      "Capture a completed conversation turn (user + assistant) into long-term memory and " +
      "trigger the extraction pipeline. Call after the assistant reply is final.",
    inputSchema: {
      type: "object",
      properties: {
        user_content: { type: "string" },
        assistant_content: { type: "string" },
        session_key: { type: "string" },
        session_id: { type: "string" },
        messages: { type: "array", description: "Optional full message history" },
      },
      required: ["user_content", "assistant_content", "session_key"],
    },
  },
];

const SERVER_INFO = {
  name: "tencentdb-agent-memory",
  version: "0.1.0",
};

// ──────────────────────────────────────────────────────────────────────────
// Tool dispatch
// ──────────────────────────────────────────────────────────────────────────

/** Clamp a numeric arg into [min, max]. */
function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : def;
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/** Build the text content block MCP expects from a tool result. */
function textContent(text: string): { type: "text"; text: string }[] {
  return [{ type: "text", text }];
}

/**
 * Execute one tool call against the adapter. Returns MCP content blocks.
 * Throws on bad args / adapter errors — the dispatcher converts to JSON-RPC.
 */
async function callTool(
  adapter: MemoryAdapter,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  try {
    switch (name) {
      case "tdai_memory_search": {
        const query = args.query;
        if (typeof query !== "string" || !query) throw new Error("`query` is required");
        const r = await adapter.searchMemories({
          query,
          limit: args.limit != null ? clampInt(args.limit, 5, 1, 20) : undefined,
          type: typeof args.type === "string" ? args.type : undefined,
          scene: typeof args.scene === "string" ? args.scene : undefined,
        });
        return { content: textContent(r.text || "(no memories)") };
      }
      case "tdai_conversation_search": {
        const query = args.query;
        if (typeof query !== "string" || !query) throw new Error("`query` is required");
        const r = await adapter.searchConversations({
          query,
          limit: args.limit != null ? clampInt(args.limit, 5, 1, 20) : undefined,
          sessionKey: typeof args.session_key === "string" ? args.session_key : undefined,
        });
        return { content: textContent(r.text || "(no conversations)") };
      }
      case "tdai_recall": {
        const query = args.query;
        const sk = args.session_key;
        if (typeof query !== "string" || typeof sk !== "string") {
          throw new Error("`query` and `session_key` are required");
        }
        const r = await adapter.recall(query, sk);
        return {
          content: textContent(
            r.appendSystemContext || r.prependContext || "(no recall context)",
          ),
        };
      }
      case "tdai_capture": {
        const uc = args.user_content;
        const ac = args.assistant_content;
        const sk = args.session_key;
        if (typeof uc !== "string" || typeof ac !== "string" || typeof sk !== "string") {
          throw new Error("`user_content`, `assistant_content`, `session_key` are required");
        }
        const r = await adapter.capture({
          userText: uc,
          assistantText: ac,
          sessionKey: sk,
          sessionId: typeof args.session_id === "string" ? args.session_id : undefined,
          messages: Array.isArray(args.messages) ? args.messages : undefined,
        });
        return {
          content: textContent(
            `Captured: l0_recorded=${r.l0RecordedCount}, scheduler_notified=${r.schedulerNotified}`,
          ),
        };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    // MCP convention: return isError=true with a text block rather than
    // crashing the server, so the client can surface the message to the model.
    const msg = err instanceof MemoryAdapterError
      ? `[${err.code}] ${err.message}`
      : err instanceof Error ? err.message : String(err);
    return { content: textContent(msg), isError: true };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// JSON-RPC dispatcher (pure — no I/O, unit-testable)
// ──────────────────────────────────────────────────────────────────────────

/** JSON-RPC error codes (MCP reuses the standard subset). */
const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/**
 * Handle one inbound JSON-RPC message.
 *
 * @returns The response to write (if any — notifications return null), or a
 *          `{ __error: ... }` sentinel on a non-JSON line.
 */
export async function handleJsonRpc(
  line: string,
  adapter: MemoryAdapter,
): Promise<JsonRpcResponse | null> {
  let msg: JsonRpcInbound;
  try {
    msg = JSON.parse(line) as JsonRpcInbound;
  } catch {
    return {
      jsonrpc: "2.0",
      id: null,
      error: { code: RPC.PARSE_ERROR, message: "Parse error" },
    };
  }

  // Notifications (no `id`) get no response per JSON-RPC 2.0.
  const id = (msg as JsonRpcRequest).id;
  if (id === undefined || id === null) {
    // We still acknowledge `notifications/initialized` silently.
    return null;
  }

  try {
    switch (msg.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: SERVER_INFO,
            capabilities: { tools: {} },
          },
        };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: TOOLS },
        };

      case "tools/call": {
        const params = (msg.params ?? {}) as {
          name?: string;
          arguments?: Record<string, unknown>;
        };
        if (!params.name) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: RPC.INVALID_PARAMS, message: "Missing `name`" },
          };
        }
        const out = await callTool(adapter, params.name, params.arguments ?? {});
        return { jsonrpc: "2.0", id, result: out };
      }

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: RPC.METHOD_NOT_FOUND, message: `Method not found: ${msg.method}` },
        };
    }
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: RPC.INTERNAL_ERROR,
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Stdio loop
// ──────────────────────────────────────────────────────────────────────────

export interface McpServerOptions {
  adapter: MemoryAdapter;
  stdin?: Readable;
  stdout?: Writable;
  /** Logger for diagnostics (must not write to stdout — stdout is the protocol). */
  logger?: { error?: (m: string) => void; debug?: (m: string) => void };
}

/**
 * Run the MCP stdio loop until stdin closes. Each line is one JSON-RPC message.
 * Designed to be the process entry point for `claude mcp add ...`.
 */
export async function runStdio(opts: McpServerOptions): Promise<void> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const log = opts.logger;

  let buffer = "";
  for await (const chunk of stdin) {
    buffer += chunk.toString();
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const resp = await handleJsonRpc(line, opts.adapter);
      if (resp) {
        stdout.write(JSON.stringify(resp) + "\n");
      } else if (log?.debug) {
        log.debug(`[mcp] notification acknowledged (no response)`);
      }
    }
  }
}
