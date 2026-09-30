/**
 * Stdio MCP server for the Codex adapter.
 *
 * Exposes TencentDB Agent Memory tools through the Model Context Protocol,
 * backed by the Gateway HTTP client.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type {
  RecallRequest,
  RecallResponse,
  CaptureRequest,
  CaptureResponse,
  MemorySearchRequest,
  MemorySearchResponse,
  ConversationSearchRequest,
  ConversationSearchResponse,
  SessionEndRequest,
  SessionEndResponse,
} from "../../gateway/types.js";
import { CodexGatewayClient } from "./gateway-client.js";
import {
  recallInputSchema,
  captureInputSchema,
  memorySearchInputSchema,
  conversationSearchInputSchema,
  sessionEndInputSchema,
  normalizeLimit,
  type RecallToolInput,
  type CaptureToolInput,
  type MemorySearchToolInput,
  type ConversationSearchToolInput,
  type SessionEndToolInput,
} from "./tool-schemas.js";

/** Abstraction over the five memory operations exposed as MCP tools. */
export interface CodexMemoryClient {
  recall(request: RecallRequest): Promise<RecallResponse>;
  capture(request: CaptureRequest): Promise<CaptureResponse>;
  searchMemories(request: MemorySearchRequest): Promise<MemorySearchResponse>;
  searchConversations(
    request: ConversationSearchRequest,
  ): Promise<ConversationSearchResponse>;
  endSession(request: SessionEndRequest): Promise<SessionEndResponse>;
}

/** Configuration object passed to `registerTool`. */
export interface ToolConfig {
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/** Minimal surface used to register tools, decouples the server from MCP SDK internals. */
export interface ToolRegistrationTarget {
  registerTool(
    name: string,
    config: ToolConfig,
    handler: (args: unknown, extra: unknown) => unknown,
  ): unknown;
}

function textResult(result: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

/** Register the five Codex memory tools on the supplied target. */
export function registerCodexMemoryTools(
  target: ToolRegistrationTarget,
  client: CodexMemoryClient,
): void {
  target.registerTool(
    "tdai_recall",
    {
      title: "TDAI Recall",
      description:
        "Recall memory context from TencentDB Agent Memory for the current Codex task. " +
        "Use before coding when prior preferences, repository conventions, or earlier sessions may matter.",
      inputSchema: recallInputSchema,
    },
    async (args) => {
      const input = recallInputSchema.parse(args) as RecallToolInput;
      const result = await client.recall(input);
      return textResult(result);
    },
  );

  target.registerTool(
    "tdai_capture",
    {
      title: "TDAI Capture",
      description:
        "Capture a completed user/assistant turn into TencentDB Agent Memory. " +
        "This is explicit capture; Codex MCP does not automatically capture every turn.",
      inputSchema: captureInputSchema,
    },
    async (args) => {
      const input = captureInputSchema.parse(args) as CaptureToolInput;
      const result = await client.capture(input);
      return textResult(result);
    },
  );

  target.registerTool(
    "tdai_memory_search",
    {
      title: "TDAI Memory Search",
      description:
        "Search structured L1 long-term memories. Use for user preferences, instructions, and episodic memory.",
      inputSchema: memorySearchInputSchema,
    },
    async (args) => {
      const input = memorySearchInputSchema.parse(args) as MemorySearchToolInput;
      const result = await client.searchMemories({
        ...input,
        limit: normalizeLimit(input.limit),
      });
      return textResult(result);
    },
  );

  target.registerTool(
    "tdai_conversation_search",
    {
      title: "TDAI Conversation Search",
      description:
        "Search raw L0 conversation history. Use when exact previous commands, tool outputs, or wording are needed.",
      inputSchema: conversationSearchInputSchema,
    },
    async (args) => {
      const input = conversationSearchInputSchema.parse(
        args,
      ) as ConversationSearchToolInput;
      const result = await client.searchConversations({
        ...input,
        limit: normalizeLimit(input.limit),
      });
      return textResult(result);
    },
  );

  target.registerTool(
    "tdai_session_end",
    {
      title: "TDAI Session End",
      description:
        "Flush pending memory pipeline work for a session key after a Codex task or session ends.",
      inputSchema: sessionEndInputSchema,
    },
    async (args) => {
      const input = sessionEndInputSchema.parse(args) as SessionEndToolInput;
      const result = await client.endSession(input);
      return textResult(result);
    },
  );
}

/** Create an MCP server backed by the given memory client. */
export function createCodexMcpServer(client: CodexMemoryClient): McpServer {
  const server = new McpServer(
    {
      name: "memory-tencentdb-codex",
      version: "0.1.0",
    },
    {
      instructions:
        "TencentDB Agent Memory for Codex. Use tdai_recall or search tools when prior user preferences, " +
        "repository conventions, or previous sessions may help. Use tdai_capture only for explicit memory writes. " +
        "This MCP server provides tools; it does not automatically intercept Codex prompts or completed turns.",
    },
  );
  registerCodexMemoryTools(server, client);
  return server;
}

/** Read environment variables, build the client, and start the stdio MCP server. */
export async function runCodexMcpServer(): Promise<void> {
  const baseUrl = process.env.TDAI_GATEWAY_URL ?? "http://127.0.0.1:8420";
  const apiKey = process.env.TDAI_GATEWAY_API_KEY;
  const timeoutMs = process.env.TDAI_GATEWAY_TIMEOUT_MS
    ? Number(process.env.TDAI_GATEWAY_TIMEOUT_MS)
    : undefined;

  const client = new CodexGatewayClient({ baseUrl, apiKey, timeoutMs });
  const server = createCodexMcpServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function isMainModule(): boolean {
  if (typeof process === "undefined") return false;
  const executedFile = process.argv[1];
  if (!executedFile) return false;
  const normalized = executedFile.replace(/\\/g, "/");
  return (
    normalized.endsWith("mcp-server.ts") || normalized.endsWith("mcp-server.js")
  );
}

if (isMainModule()) {
  runCodexMcpServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
