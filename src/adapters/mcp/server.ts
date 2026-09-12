import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import packageJson from "../../../package.json" with { type: "json" };

import {
  GatewayMemoryClient,
  type GatewayMemoryClientOptions,
} from "../gateway/client.js";
import type { MemoryService } from "../gateway/types.js";
import {
  registerMemoryTools,
  type McpToolRegistrar,
  type MemoryToolDefaults,
} from "./tools.js";

const SERVER_NAME = "tencentdb-agent-memory";
const SERVER_VERSION = packageJson.version;

const SERVER_INSTRUCTIONS =
  "Use tdai_recall before answering when prior preferences, decisions, or project context may matter. " +
  "Use tdai_memory_search for structured long-term facts and tdai_conversation_search for exact prior dialogue. " +
  "After a meaningful completed turn, call tdai_capture with the original user message and final assistant response. " +
  "Call tdai_session_end when the host session is ending.";

export interface MemoryMcpServerOptions extends MemoryToolDefaults {
  /** Existing service implementation, primarily for embedding and tests. */
  service?: MemoryService;
  /** Gateway client options used when service is not supplied. */
  gateway?: GatewayMemoryClientOptions;
}

/**
 * Create an MCP server backed by the platform-neutral MemoryService contract.
 */
export function createMemoryMcpServer(options: MemoryMcpServerOptions): McpServer {
  const service = options.service ?? createGatewayService(options.gateway);
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  // McpServer's registerTool method is generic, while registerMemoryTools
  // intentionally depends on a minimal structural interface for testability.
  registerMemoryTools(
    server as unknown as McpToolRegistrar,
    service,
    {
      sessionKey: options.sessionKey,
      userId: options.userId,
    },
  );

  return server;
}

/**
 * Start the local stdio transport used by Claude Code, Codex, and other MCP
 * hosts. All diagnostic output must go to stderr so stdout remains valid MCP.
 */
export async function runMemoryMcpServer(
  options: MemoryMcpServerOptions,
): Promise<McpServer> {
  const server = createMemoryMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

function createGatewayService(
  options: GatewayMemoryClientOptions | undefined,
): MemoryService {
  if (!options) {
    throw new Error("Gateway options are required when no MemoryService is supplied");
  }
  return new GatewayMemoryClient(options);
}
