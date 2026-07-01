#!/usr/bin/env node

const DEFAULT_BASE_URL = "http://127.0.0.1:8420";

function resolveGatewayBaseUrl() {
  if (process.env.MEMORY_TENCENTDB_GATEWAY_URL?.trim()) {
    return process.env.MEMORY_TENCENTDB_GATEWAY_URL.trim().replace(/\/+$/, "");
  }
  const host = process.env.MEMORY_TENCENTDB_GATEWAY_HOST || "127.0.0.1";
  const port = process.env.MEMORY_TENCENTDB_GATEWAY_PORT || "8420";
  return `http://${host}:${port}`.replace(/\/+$/, "") || DEFAULT_BASE_URL;
}

function resolveGatewayApiKey() {
  return (
    process.env.MEMORY_TENCENTDB_GATEWAY_API_KEY ||
    process.env.TDAI_GATEWAY_API_KEY ||
    ""
  ).trim();
}

async function gatewayPost(path, body) {
  const headers = { "Content-Type": "application/json" };
  const apiKey = resolveGatewayApiKey();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(`${resolveGatewayBaseUrl()}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data?.error || `Gateway ${path} failed: ${response.status}`);
  }
  return data;
}

const tools = [
  {
    name: "memory_tencentdb_memory_search",
    description: "Search structured long-term memories from memory-tencentdb.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
        type: { type: "string" },
        scene: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_tencentdb_conversation_search",
    description: "Search raw conversation history from memory-tencentdb.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
        session_key: { type: "string" },
      },
      required: ["query"],
    },
  },
];

function clampLimit(raw) {
  const n = Number(raw) || 5;
  return Math.min(Math.max(n, 1), 20);
}

async function callTool(name, args = {}) {
  const query = String(args.query || "");
  if (!query) {
    return { isError: true, content: [{ type: "text", text: "Missing required parameter: query" }] };
  }

  if (name === "memory_tencentdb_memory_search") {
    const result = await gatewayPost("/search/memories", {
      query,
      limit: clampLimit(args.limit),
      type: typeof args.type === "string" ? args.type : undefined,
      scene: typeof args.scene === "string" ? args.scene : undefined,
    });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  if (name === "memory_tencentdb_conversation_search") {
    const result = await gatewayPost("/search/conversations", {
      query,
      limit: clampLimit(args.limit),
      session_key: typeof args.session_key === "string" ? args.session_key : undefined,
    });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }

  return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
}

async function handleRequest(req) {
  if (req.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: req.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "memory-tencentdb", version: "0.3.6" },
      },
    };
  }
  if (req.method === "notifications/initialized") return undefined;
  if (req.method === "tools/list") {
    return { jsonrpc: "2.0", id: req.id, result: { tools } };
  }
  if (req.method === "tools/call") {
    const name = String(req.params?.name || "");
    const args = req.params?.arguments && typeof req.params.arguments === "object"
      ? req.params.arguments
      : {};
    return { jsonrpc: "2.0", id: req.id, result: await callTool(name, args) };
  }
  return {
    jsonrpc: "2.0",
    id: req.id,
    error: { code: -32601, message: `Method not found: ${req.method}` },
  };
}

function readFrame(buffer) {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd < 0) return undefined;
  const header = buffer.slice(0, headerEnd).toString("utf-8");
  const match = /^Content-Length:\s*(\d+)$/im.exec(header);
  if (!match) throw new Error("Invalid MCP frame: missing Content-Length");
  const length = Number(match[1]);
  const bodyStart = headerEnd + 4;
  const bodyEnd = bodyStart + length;
  if (buffer.length < bodyEnd) return undefined;
  return {
    request: JSON.parse(buffer.slice(bodyStart, bodyEnd).toString("utf-8")),
    rest: buffer.slice(bodyEnd),
  };
}

function writeFrame(res) {
  const body = Buffer.from(JSON.stringify(res), "utf-8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function writeLine(res) {
  process.stdout.write(`${JSON.stringify(res)}\n`);
}

let buffer = Buffer.alloc(0);
let transport = "unknown";

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);

  if (transport === "unknown") {
    const trimmed = buffer.toString("utf-8", 0, Math.min(buffer.length, 32)).trimStart();
    if (trimmed.startsWith("Content-Length:")) transport = "frame";
    else if (trimmed.startsWith("{") || trimmed.startsWith("[")) transport = "line";
  }

  if (transport === "frame") {
    while (true) {
      let parsed;
      try {
        parsed = readFrame(buffer);
      } catch (err) {
        console.error(`[memory-tencentdb-mcp] ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      if (!parsed) break;
      buffer = parsed.rest;
      handleRequest(parsed.request)
        .then((res) => {
          if (res) writeFrame(res);
        })
        .catch((err) => {
          writeFrame({
            jsonrpc: "2.0",
            id: parsed.request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        });
    }
    return;
  }

  if (transport === "line") {
    while (true) {
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd < 0) break;
      const line = buffer.slice(0, lineEnd).toString("utf-8").trim();
      buffer = buffer.slice(lineEnd + 1);
      if (!line) continue;
      let request;
      try {
        request = JSON.parse(line);
      } catch (err) {
        console.error(`[memory-tencentdb-mcp] invalid JSON line: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      handleRequest(request)
        .then((res) => {
          if (res) writeLine(res);
        })
        .catch((err) => {
          writeLine({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        });
    }
  }
});

