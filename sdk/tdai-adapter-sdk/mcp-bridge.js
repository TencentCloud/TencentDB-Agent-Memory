/**
 * MCP bridge factory — a minimal Model Context Protocol server over stdio
 * (newline-delimited JSON-RPC 2.0, no external dependencies).
 *
 * Extracted from the previously duplicated whale/codex `mcp-bridge.js`. It
 * proxies `search_memories` and `search_conversations` tool calls to the
 * TdaiGateway via a shared `TdaiGatewayClient` (which adds Bearer auth and
 * timeouts the raw bridges lacked), exposing TencentDB Agent Memory to any
 * MCP-aware host (Codex, Whale, etc.).
 *
 * Wire compatibility: protocol version, serverInfo, tool names, input schemas
 * and output shapes are byte-identical to the original bridges.
 *
 * Usage (a plugin's mcp-bridge.js becomes):
 *   import { TdaiGatewayClient, createMcpBridge } from "./vendor/tdai-sdk/index.js";
 *   createMcpBridge({ client: new TdaiGatewayClient() }).start();
 */

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "tdai-memory", version: "1.0.0" };

const TOOLS = [
  {
    name: "search_memories",
    description:
      "Search the structured L1 memory store (records, scenes, persona) for relevant past knowledge.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (optional)" },
        type: { type: "string", description: "Filter by memory type (optional)" },
        scene: { type: "string", description: "Filter by scene (optional)" },
      },
      required: ["query"],
    },
  },
  {
    name: "search_conversations",
    description:
      "Search raw past conversations (L0) for relevant context by keyword/semantic query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (optional)" },
        session_key: { type: "string", description: "Restrict to a session (optional)" },
      },
      required: ["query"],
    },
  },
];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * @param {Object} opts
 * @param {import("./gateway-client.js").TdaiGatewayClient} opts.client
 * @param {NodeJS.ReadableStream} [opts.input]  Defaults to process.stdin.
 * @param {(s: string) => void} [opts.write]    Defaults to process.stdout.write.
 * @returns {{ start: () => void, handle: (message: any) => Promise<void>, tools: typeof TOOLS }}
 */
export function createMcpBridge(opts) {
  const client = opts.client;
  const write = opts.write ?? ((s) => process.stdout.write(s));
  const input = opts.input ?? process.stdin;

  function send(obj) {
    write(JSON.stringify(obj) + "\n");
  }

  async function callTool(name, args) {
    if (name === "search_memories") {
      const result = await client.searchMemories({
        query: args.query,
        limit: num(args.limit),
        type: args.type,
        scene: args.scene,
      });
      const text =
        typeof result.results === "string"
          ? result.results
          : JSON.stringify(result, null, 2);
      return { content: [{ type: "text", text }], isError: false };
    }
    if (name === "search_conversations") {
      const result = await client.searchConversations({
        query: args.query,
        limit: num(args.limit),
        sessionKey: args.session_key,
      });
      const text =
        typeof result.results === "string"
          ? result.results
          : JSON.stringify(result, null, 2);
      return { content: [{ type: "text", text }], isError: false };
    }
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }

  async function handle(message) {
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        },
      });
      return;
    }
    if (message.method === "notifications/initialized") return;
    if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
      return;
    }
    if (message.method === "tools/call") {
      try {
        const r = await callTool(message.params.name, message.params.arguments || {});
        send({ jsonrpc: "2.0", id: message.id, result: { content: r.content, isError: r.isError } });
      } catch (e) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true },
        });
      }
      return;
    }
    if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
    }
  }

  /** Attach the newline-delimited JSON-RPC loop to the input stream. */
  function start() {
    let buffer = "";
    input.setEncoding?.("utf-8");
    input.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) {
          try {
            void handle(JSON.parse(line));
          } catch {
            // ignore malformed lines
          }
        }
      }
    });
  }

  return { start, handle, tools: TOOLS };
}
