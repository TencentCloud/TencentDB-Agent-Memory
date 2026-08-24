#!/usr/bin/env node
import { config, gatewayRequest } from "./core.mjs";

const cfg = config();
const tools = [
  { name: "memory_status", description: "Check TencentDB Agent Memory Gateway connectivity and current scope.", inputSchema: { type: "object", properties: {} } },
  { name: "memory_recall", description: "Recall long-term memory relevant to a query.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "memory_search", description: "Search extracted long-term memories.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 }, type: { type: "string" }, scene: { type: "string" } }, required: ["query"] } },
  { name: "conversation_search", description: "Search raw conversations captured in memory.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 }, current_agent_only: { type: "boolean", default: true } }, required: ["query"] } },
];

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function content(value) { return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] }; }

async function call(name, args = {}) {
  if (name === "memory_status") {
    const health = await gatewayRequest("/health", undefined, { config: cfg, method: "GET" });
    return content({ ...health, gateway_url: cfg.gatewayUrl, session_key: cfg.sessionKey });
  }
  if (name === "memory_recall") return content((await gatewayRequest("/recall", { query: args.query, session_key: cfg.sessionKey }, { config: cfg })).context || "No relevant memory found.");
  if (name === "memory_search") return content((await gatewayRequest("/search/memories", { query: args.query, limit: args.limit, type: args.type, scene: args.scene }, { config: cfg })).results || "No memories found.");
  if (name === "conversation_search") return content((await gatewayRequest("/search/conversations", { query: args.query, limit: args.limit, session_key: args.current_agent_only === false ? undefined : cfg.sessionKey }, { config: cfg })).results || "No conversations found.");
  throw new Error(`Unknown tool: ${name}`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === "notifications/initialized") continue;
    try {
      let result;
      if (message.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "tencentdb-agent-memory-cursor", version: "0.1.0" } };
      else if (message.method === "tools/list") result = { tools };
      else if (message.method === "tools/call") result = await call(message.params?.name, message.params?.arguments);
      else {
        if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
        continue;
      }
      if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
    }
  }
});
