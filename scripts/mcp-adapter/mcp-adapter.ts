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
import {
  asRecord,
  GatewayMemoryOperations,
  getMcpToolDefinitions,
  requireString,
  TdaiAdapterRuntime,
  TdaiGatewayClient,
  toMcpResult,
} from "../../src/adapter-sdk/index.js";
import type { McpJsonValue } from "../../src/adapter-sdk/index.js";

const SERVER_NAME = "memory-tencentdb-mcp";
const SERVER_VERSION = "0.1.0";
const DEFAULT_GATEWAY_HOST = "127.0.0.1";
const DEFAULT_GATEWAY_PORT = 8420;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_SESSION_KEY = "mcp-default";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface McpConfig {
  gatewayUrl: string;
  apiKey?: string;
  timeoutMs: number;
  defaultSessionKey: string;
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

export class McpServer {
  private readonly runtime: TdaiAdapterRuntime;
  private readonly config: McpConfig;

  constructor(config: McpConfig) {
    this.config = config;
    const client = new TdaiGatewayClient({
      baseUrl: config.gatewayUrl,
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
    });
    this.runtime = new TdaiAdapterRuntime({
      operations: new GatewayMemoryOperations({
        client,
        defaultSessionKey: config.defaultSessionKey,
      }),
    });
  }

  async handle(request: JsonRpcRequest): Promise<McpJsonValue | undefined> {
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
        return { tools: getMcpToolDefinitions() as unknown as McpJsonValue[] };
      case "tools/call":
        return this.handleToolCall(asRecord(request.params));
      default:
        throw new Error(`Unsupported MCP method: ${request.method ?? "(missing)"}`);
    }
  }

  private async handleToolCall(params: Record<string, unknown>): Promise<McpJsonValue> {
    const name = requireString(params, "name");
    const args = asRecord(params.arguments);
    const result = await this.runtime.handleToolCall(
      { name, arguments: args },
      { sessionKey: this.config.defaultSessionKey },
    );
    return toMcpResult(result) as McpJsonValue;
  }
}

function resolveProtocolVersion(params: unknown): string {
  const requested = asRecord(params).protocolVersion;
  return typeof requested === "string" && requested.trim() ? requested : "2024-11-05";
}

function writeResponse(id: JsonRpcRequest["id"], result: McpJsonValue): void {
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
