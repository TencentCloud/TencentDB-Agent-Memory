/**
 * MCP stdio server — exposes knowledge query tools to LLM agents.
 *
 * Runs as a separate process with stdio transport. When an agent calls a tool,
 * the server forwards the request to the Hono HTTP API via callApi().
 *
 * Usage:
 *   KNOWLEDGE_API_URL=http://localhost:8421 \
 *   KNOWLEDGE_SERVICE_ID=<tenant-id> \
 *   node dist/mcp/server.js
 *
 * The agent connects via stdio; the server translates tool calls to HTTP
 * requests against the knowledge service. `KNOWLEDGE_SERVICE_ID` is sent as
 * the `x-tdai-service-id` header, which every /v3 endpoint requires.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { MCP_TOOLS, type McpToolDef } from "./tools.js";
import { callApi, type HttpClientOptions } from "./http-client.js";
import { createLogger } from "../logger.js";

const log = createLogger("mcp-server");

export function createMcpServer(httpOpts: HttpClientOptions): Server {
  const toolMap = new Map<string, McpToolDef>();
  for (const tool of MCP_TOOLS) {
    toolMap.set(tool.name, tool);
  }

  const server = new Server(
    { name: "knowledge-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: MCP_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  // Call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) {
      log.warn(`Unknown tool requested: "${name}"`);
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    const body = (args ?? {}) as Record<string, unknown>;
    try {
      const data = await callApi(httpOpts, tool.endpoint, body);

      // The code-graph query endpoints return {text, isError} — pass through directly
      if (data && typeof data === "object" && "text" in data && "isError" in data) {
        const result = data as { text: string; isError: boolean };
        return {
          content: [{ type: "text", text: result.text || "(empty result)" }],
          isError: result.isError,
        };
      }

      // Other endpoints return structured data — serialize as JSON
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        isError: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`tool ${name} failed: ${msg}`);
      return {
        content: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
      };
    }
  });

  return server;
}

// Start server when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const baseUrl = process.env.KNOWLEDGE_API_URL || "http://localhost:8421";
  const token = process.env.KNOWLEDGE_API_TOKEN;
  const serviceId = process.env.KNOWLEDGE_SERVICE_ID;

  log.info(`MCP server starting, API URL: ${baseUrl}`);

  const server = createMcpServer({ baseUrl, token, serviceId });
  const transport = new StdioServerTransport();

  server.connect(transport).then(() => {
    log.info("MCP server connected via stdio");
  }).catch((err) => {
    log.error(`Failed to connect: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
