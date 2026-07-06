import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GatewayClient } from "./gateway-client.js";
import { ensureGateway } from "./gateway-supervisor.js";
import type { Logger } from "./types.js";

export interface MemoryMcpServerOptions {
  name?: string;
  version?: string;
  gatewayUrl?: string;
  apiKey?: string;
  checkGateway?: boolean;
  logger?: Logger;
}

export async function runMemoryMcpServer(opts: MemoryMcpServerOptions = {}): Promise<void> {
  const logger = opts.logger ?? stderrLogger("[tdai-mcp]");
  const gateway = new GatewayClient({
    baseUrl: opts.gatewayUrl,
    apiKey: opts.apiKey,
    logger,
  });

  if (opts.checkGateway ?? true) {
    await ensureGateway({ gateway, logger });
  }

  const server = new McpServer({
    name: opts.name ?? "tencentdb-memory",
    version: opts.version ?? "1.0.0",
  });

  server.tool(
    "tdai_memory_search",
    {
      query: z.string(),
      limit: z.number().optional(),
      type: z.string().optional(),
      scene: z.string().optional(),
    },
    async (params) => {
      try {
        const result = await gateway.searchMemories(params);
        return { content: [{ type: "text" as const, text: result.results ?? "" }] };
      } catch {
        return unavailable("Memory search unavailable. Please try again later.");
      }
    },
  );

  server.tool(
    "tdai_conversation_search",
    {
      query: z.string(),
      limit: z.number().optional(),
      session_key: z.string().optional(),
    },
    async (params) => {
      try {
        const result = await gateway.searchConversations(params);
        return { content: [{ type: "text" as const, text: result.results ?? "" }] };
      } catch {
        return unavailable("Conversation search unavailable. Please try again later.");
      }
    },
  );

  await server.connect(new StdioServerTransport());
}

function unavailable(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true as const,
  };
}

function stderrLogger(tag: string): Logger {
  const write = (message: string) => process.stderr.write(`${tag} ${message}\n`);
  return {
    debug: write,
    info: write,
    warn: write,
    error: write,
  };
}
