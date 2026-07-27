#!/usr/bin/env node
/**
 * Tdai MCP bridge — a minimal Model Context Protocol server over stdio
 * (newline-delimited JSON-RPC 2.0, no external dependencies).
 *
 * It proxies `search_memories` and `search_conversations` tool calls to the
 * TdaiGateway HTTP endpoints, exposing TencentDB Agent Memory to any MCP-aware
 * host (Codex, Whale, etc.).
 *
 * Env:
 *   TDAI_GATEWAY_URL   Gateway base URL (default http://127.0.0.1:8420)
 */

import http from "node:http";

const GATEWAY = process.env.TDAI_GATEWAY_URL || "http://127.0.0.1:8420";

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

function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, GATEWAY);
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": data.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

async function callTool(name, args) {
  if (name === "search_memories") {
    const result = await httpPost("/search/memories", {
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
    const result = await httpPost("/search/conversations", {
      query: args.query,
      limit: num(args.limit),
      session_key: args.session_key,
    });
    const text =
      typeof result.results === "string"
        ? result.results
        : JSON.stringify(result, null, 2);
    return { content: [{ type: "text", text }], isError: false };
  }
  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
}

// ---- Minimal JSON-RPC over stdio ----

let buffer = "";

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(message) {
  if (!message || message.jsonrpc !== "2.0") return;
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "tdai-memory", version: "1.0.0" },
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
    callTool(message.params.name, message.params.arguments || {})
      .then((r) =>
        send({ jsonrpc: "2.0", id: message.id, result: { content: r.content, isError: r.isError } })
      )
      .catch((e) =>
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true },
        })
      );
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  }
}

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch {
        // ignore malformed lines
      }
    }
  }
});
