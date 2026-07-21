#!/usr/bin/env -S npx tsx
/**
 * Claude Code MCP server (memory tools).
 *
 * Exposes `memory_search` and `conversation_search` to Claude Code as MCP
 * tools, backed by the TDAI Gateway via the SDK. It is a minimal, dependency
 * free implementation of the MCP stdio transport (newline-delimited JSON-RPC
 * 2.0) — we implement only the three methods Claude Code needs:
 *   - initialize
 *   - tools/list
 *   - tools/call
 *
 * Register it with:
 *   claude mcp add memory-tencentdb -- npx tsx /abs/path/mcp-server.ts
 * or via .mcp.json (see settings.example.json / README).
 */

import { createInterface } from "node:readline";
import { createAdapterFromEnv } from "../../src/index.js";
import { resolveGatewayConfig } from "../../src/config.js";
import { ClaudeCodeBinding } from "./binding.js";
import type { ToolDescriptor } from "../../src/types.js";

const SERVER_NAME = "memory-tencentdb";
const SERVER_VERSION = "0.1.0";
const DEFAULT_PROTOCOL = "2024-11-05";

const logger = {
  debug: (m: string) => process.env.MEMORY_TENCENTDB_DEBUG && process.stderr.write(`${m}\n`),
  info: (m: string) => process.stderr.write(`${m}\n`),
  warn: (m: string) => process.stderr.write(`${m}\n`),
  error: (m: string) => process.stderr.write(`${m}\n`),
};

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function result(id: string | number | null | undefined, res: unknown): void {
  send({ jsonrpc: "2.0", id: id ?? null, result: res });
}

function error(id: string | number | null | undefined, code: number, message: string): void {
  send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function toMcpTools(tools: ToolDescriptor[]): unknown[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
  }));
}

function main(): void {
  const cfg = resolveGatewayConfig();
  const binding = new ClaudeCodeBinding({ userId: cfg.userId });
  const adapter = createAdapterFromEnv(binding, logger);

  const rl = createInterface({ input: process.stdin });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      return; // ignore non-JSON lines
    }

    // Notifications (no id) require no response.
    const isNotification = req.id === undefined || req.id === null;

    void handle(req).catch((err) => {
      if (!isNotification) {
        error(req.id, -32603, err instanceof Error ? err.message : String(err));
      }
    });
  });

  async function handle(req: JsonRpcRequest): Promise<void> {
    switch (req.method) {
      case "initialize": {
        const requested = (req.params?.protocolVersion as string) || DEFAULT_PROTOCOL;
        result(req.id, {
          protocolVersion: requested,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
        return;
      }
      case "notifications/initialized":
      case "initialized":
        return; // notification, no response
      case "ping":
        result(req.id, {});
        return;
      case "tools/list":
        result(req.id, { tools: toMcpTools(adapter.listTools()) });
        return;
      case "tools/call": {
        const name = String(req.params?.name ?? "");
        const args = (req.params?.arguments as Record<string, unknown>) ?? {};
        const out = await adapter.handleToolCall(name, args);
        const text =
          "error" in out
            ? JSON.stringify(out)
            : out.results || "(no results)";
        result(req.id, {
          content: [{ type: "text", text }],
          isError: "error" in out,
        });
        return;
      }
      default:
        if (req.id !== undefined && req.id !== null) {
          error(req.id, -32601, `Method not found: ${req.method}`);
        }
        return;
    }
  }

  logger.info(`[${SERVER_NAME}] MCP server ready (gateway=${cfg.baseUrl})`);
}

main();
