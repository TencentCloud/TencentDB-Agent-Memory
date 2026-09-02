import { pathToFileURL } from "node:url";
import { loadClaudeCodeAdapterConfig } from "../config.js";
import { TdaiGatewayClient } from "../gateway-client.js";
import { callClaudeCodeMcpTool, CLAUDE_CODE_MCP_TOOLS } from "./tools.js";

interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function makeResponse(id: JsonRpcRequest["id"], result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function makeError(id: JsonRpcRequest["id"], code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function writeFramed(json: string): void {
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`);
}

async function handleRequest(req: JsonRpcRequest, client: TdaiGatewayClient): Promise<string | undefined> {
  if (req.method === "initialize") {
    return makeResponse(req.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: {
        name: "memory-tencentdb-claude-code",
        version: "0.1.0",
      },
    });
  }
  if (req.method === "notifications/initialized") return undefined;
  if (req.method === "tools/list") {
    return makeResponse(req.id, { tools: CLAUDE_CODE_MCP_TOOLS });
  }
  if (req.method === "tools/call") {
    const name = typeof req.params?.name === "string" ? req.params.name : "";
    const args = req.params?.arguments;
    const result = await callClaudeCodeMcpTool(client, name, args);
    return makeResponse(req.id, result);
  }
  return makeError(req.id, -32601, `Method not found: ${req.method}`);
}

async function dispatchMessage(json: string, client: TdaiGatewayClient): Promise<void> {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(json) as JsonRpcRequest;
  } catch {
    writeFramed(makeError(null, -32700, "Parse error"));
    return;
  }
  try {
    const response = await handleRequest(request, client);
    if (response) writeFramed(response);
  } catch (err) {
    writeFramed(makeError(request.id, -32000, err instanceof Error ? err.message : String(err)));
  }
}

export async function runClaudeCodeMcpServer(): Promise<void> {
  const config = loadClaudeCodeAdapterConfig();
  const client = new TdaiGatewayClient({
    baseUrl: config.gatewayUrl,
    apiKey: config.gatewayApiKey,
  });

  let buffer = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);

    while (buffer.length > 0) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd >= 0) {
        const header = buffer.slice(0, headerEnd).toString("utf-8");
        const match = /content-length:\s*(\d+)/i.exec(header);
        if (!match) {
          buffer = buffer.slice(headerEnd + 4);
          continue;
        }
        const length = Number.parseInt(match[1], 10);
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + length;
        if (buffer.length < bodyEnd) break;
        const body = buffer.slice(bodyStart, bodyEnd).toString("utf-8");
        buffer = buffer.slice(bodyEnd);
        await dispatchMessage(body, client);
        continue;
      }

      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).toString("utf-8").trim();
      buffer = buffer.slice(newline + 1);
      if (line) await dispatchMessage(line, client);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runClaudeCodeMcpServer().catch((err) => {
    console.error(`[memory-tencentdb:claude-code] MCP server failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
