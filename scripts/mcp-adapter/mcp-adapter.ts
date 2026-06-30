#!/usr/bin/env node
/**
 * MCP stdio adapter for memory-tencentdb.
 *
 * This adapter exposes the existing Gateway HTTP API as MCP tools so clients
 * such as Claude Code, Codex, or other MCP-capable agents can read and write
 * memory without linking against OpenClaw or Hermes internals.
 */

import readline from "node:readline";
import { stdin as input, stdout as output, stderr } from "node:process";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "memory-tencentdb-mcp";
const SERVER_VERSION = "0.1.0";
const DEFAULT_GATEWAY_HOST = "127.0.0.1";
const DEFAULT_GATEWAY_PORT = 8420;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_SESSION_KEY = "mcp-default";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface GatewayClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
}

interface McpConfig {
  gatewayUrl: string;
  apiKey?: string;
  timeoutMs: number;
  defaultSessionKey: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonValue;
  [key: string]: JsonValue;
}

function log(message: string): void {
  stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

function readConfigFromEnv(): McpConfig {
  const explicitUrl = process.env.MEMORY_TENCENTDB_GATEWAY_URL?.trim();
  const host = process.env.MEMORY_TENCENTDB_GATEWAY_HOST?.trim() || DEFAULT_GATEWAY_HOST;
  const port = parseIntegerEnv("MEMORY_TENCENTDB_GATEWAY_PORT", DEFAULT_GATEWAY_PORT);
  const timeoutMs = parseIntegerEnv("MEMORY_TENCENTDB_MCP_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const defaultSessionKey = process.env.MEMORY_TENCENTDB_MCP_SESSION_KEY?.trim() || DEFAULT_SESSION_KEY;
  const apiKey =
    process.env.MEMORY_TENCENTDB_GATEWAY_API_KEY?.trim() ||
    process.env.TDAI_GATEWAY_API_KEY?.trim() ||
    undefined;

  return {
    gatewayUrl: explicitUrl || `http://${host}:${port}`,
    apiKey,
    timeoutMs,
    defaultSessionKey,
  };
}

function parseIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    log(`Ignoring invalid ${name}=${JSON.stringify(raw)}; using ${fallback}.`);
    return fallback;
  }
  return value;
}

export class GatewayClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(options: GatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
  }

  async health(): Promise<unknown> {
    return this.request("GET", "/health");
  }

  async recall(args: Record<string, unknown>, defaultSessionKey: string): Promise<unknown> {
    return this.request("POST", "/recall", {
      query: requireString(args, "query"),
      session_key: optionalString(args, "session_key") || defaultSessionKey,
      user_id: optionalString(args, "user_id") || undefined,
    });
  }

  async capture(args: Record<string, unknown>, defaultSessionKey: string): Promise<unknown> {
    return this.request("POST", "/capture", {
      user_content: requireString(args, "user_content"),
      assistant_content: requireString(args, "assistant_content"),
      session_key: optionalString(args, "session_key") || defaultSessionKey,
      session_id: optionalString(args, "session_id") || undefined,
      user_id: optionalString(args, "user_id") || undefined,
      messages: Array.isArray(args.messages) ? args.messages : undefined,
    });
  }

  async searchMemories(args: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/search/memories", {
      query: requireString(args, "query"),
      limit: optionalPositiveInteger(args, "limit"),
      type: optionalString(args, "type") || undefined,
      scene: optionalString(args, "scene") || undefined,
    });
  }

  async searchConversations(args: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/search/conversations", {
      query: requireString(args, "query"),
      limit: optionalPositiveInteger(args, "limit"),
      session_key: optionalString(args, "session_key") || undefined,
    });
  }

  async endSession(args: Record<string, unknown>, defaultSessionKey: string): Promise<unknown> {
    return this.request("POST", "/session/end", {
      session_key: optionalString(args, "session_key") || defaultSessionKey,
      user_id: optionalString(args, "user_id") || undefined,
    });
  }

  private async request(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {};
      if (method === "POST") headers["Content-Type"] = "application/json";
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: method === "POST" ? JSON.stringify(compactObject(body ?? {})) : undefined,
        signal: controller.signal,
      });

      const text = await response.text();
      let payload: unknown = text;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = text;
        }
      }

      if (!response.ok) {
        throw new Error(`Gateway ${method} ${path} failed (${response.status}): ${formatUnknown(payload)}`);
      }
      return payload;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Gateway ${method} ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

function compactObject<T extends Record<string, unknown>>(inputObj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputObj)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (!value) throw new Error(`Missing required argument: ${key}`);
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalPositiveInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function textResult(value: unknown): JsonValue {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorResult(err: unknown): JsonValue {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function toolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "memory_tencentdb_health",
      description: "Check whether the memory-tencentdb Gateway is reachable.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "memory_tencentdb_recall",
      description: "Recall long-term memory context for a user query before answering.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "User query or current task text." },
          session_key: { type: "string", description: "Stable conversation/session key. Defaults to MEMORY_TENCENTDB_MCP_SESSION_KEY or mcp-default." },
          user_id: { type: "string", description: "Optional user identifier." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "memory_tencentdb_capture",
      description: "Capture a completed user/assistant turn into memory.",
      inputSchema: {
        type: "object",
        properties: {
          user_content: { type: "string", description: "User message text." },
          assistant_content: { type: "string", description: "Assistant response text." },
          session_key: { type: "string", description: "Stable conversation/session key. Defaults to MEMORY_TENCENTDB_MCP_SESSION_KEY or mcp-default." },
          session_id: { type: "string", description: "Optional per-conversation session id." },
          user_id: { type: "string", description: "Optional user identifier." },
          messages: { type: "array", description: "Optional raw message array to preserve richer turn structure." },
        },
        required: ["user_content", "assistant_content"],
        additionalProperties: false,
      },
    },
    {
      name: "memory_tencentdb_memory_search",
      description: "Search L1 structured memories such as persona, episodic, and instruction records.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          limit: { type: "integer", description: "Maximum number of results." },
          type: { type: "string", enum: ["persona", "episodic", "instruction"], description: "Optional memory type filter." },
          scene: { type: "string", description: "Optional scene name filter." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "memory_tencentdb_conversation_search",
      description: "Search L0 raw conversation history.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          limit: { type: "integer", description: "Maximum number of messages." },
          session_key: { type: "string", description: "Optional session key filter." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "memory_tencentdb_session_end",
      description: "Flush buffered work for a session when the conversation ends.",
      inputSchema: {
        type: "object",
        properties: {
          session_key: { type: "string", description: "Session key to flush. Defaults to MEMORY_TENCENTDB_MCP_SESSION_KEY or mcp-default." },
          user_id: { type: "string", description: "Optional user identifier." },
        },
        additionalProperties: false,
      },
    },
  ];
}

export class McpServer {
  private readonly gateway: GatewayClient;
  private readonly config: McpConfig;

  constructor(config: McpConfig) {
    this.config = config;
    this.gateway = new GatewayClient({
      baseUrl: config.gatewayUrl,
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
    });
  }

  async handle(request: JsonRpcRequest): Promise<JsonValue | undefined> {
    switch (request.method) {
      case "initialize":
        return {
          protocolVersion: resolveProtocolVersion(request.params),
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        };
      case "notifications/initialized":
        return undefined;
      case "ping":
        return {};
      case "tools/list":
        return { tools: toolDefinitions() };
      case "tools/call":
        return this.handleToolCall(asRecord(request.params));
      default:
        throw new Error(`Unsupported MCP method: ${request.method ?? "(missing)"}`);
    }
  }

  private async handleToolCall(params: Record<string, unknown>): Promise<JsonValue> {
    const name = requireString(params, "name");
    const args = asRecord(params.arguments);

    try {
      switch (name) {
        case "memory_tencentdb_health":
          return textResult(await this.gateway.health());
        case "memory_tencentdb_recall":
          return textResult(await this.gateway.recall(args, this.config.defaultSessionKey));
        case "memory_tencentdb_capture":
          return textResult(await this.gateway.capture(args, this.config.defaultSessionKey));
        case "memory_tencentdb_memory_search":
          return textResult(await this.gateway.searchMemories(args));
        case "memory_tencentdb_conversation_search":
          return textResult(await this.gateway.searchConversations(args));
        case "memory_tencentdb_session_end":
          return textResult(await this.gateway.endSession(args, this.config.defaultSessionKey));
        default:
          return errorResult(`Unknown tool: ${name}`);
      }
    } catch (err) {
      return errorResult(err);
    }
  }
}

function resolveProtocolVersion(params: unknown): string {
  const requested = asRecord(params).protocolVersion;
  return typeof requested === "string" && requested.trim() ? requested : "2024-11-05";
}

function writeResponse(id: JsonRpcRequest["id"], result: JsonValue): void {
  output.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function writeError(id: JsonRpcRequest["id"], code: number, message: string): void {
  output.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

export async function main(): Promise<void> {
  const config = readConfigFromEnv();
  const server = new McpServer(config);
  log(`MCP adapter started; gateway=${config.gatewayUrl}, session=${config.defaultSessionKey}`);

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on("line", (line) => {
    void (async () => {
      if (!line.trim()) return;
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch (err) {
        writeError(null, -32700, `Parse error: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      const hasId = Object.prototype.hasOwnProperty.call(request, "id");
      try {
        const result = await server.handle(request);
        if (hasId && result !== undefined) writeResponse(request.id, result);
      } catch (err) {
        if (hasId) writeError(request.id, -32603, err instanceof Error ? err.message : String(err));
      }
    })();
  });
}

if (isMainModule()) {
  main().catch((err) => {
    log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

function isMainModule(): boolean {
  return process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
}
