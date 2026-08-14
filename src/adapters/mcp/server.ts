import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { createMemoryTools } from "./tools.js";
import type { MemoryGatewayOptions } from "./gateway.js";

const SERVER_INSTRUCTIONS =
  "TencentDB Agent Memory tools. Lifecycle hooks perform automatic recall and capture. " +
  "Use search tools only when additional historical context is needed, and do not capture a turn twice.";

export function createMemoryMcpServer(options: MemoryGatewayOptions = {}): McpServer {
  const tools = createMemoryTools(options);
  const server = new McpServer(
    { name: "memory-tencentdb", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool("tdai_memory_recall", {
    title: "Recall memory",
    description: "Recall relevant long-term memory before an agent turn.",
    inputSchema: {
      query: z.string().min(1).describe("Current user prompt or recall query."),
      session_key: z.string().min(1).describe("Stable host-specific session key."),
    },
    outputSchema: {
      context: z.string(),
      strategy: z.string().optional(),
      memory_count: z.number().int().nonnegative(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ query, session_key }) => {
    const result = await tools.recall({ query, sessionKey: session_key });
    const structuredContent = {
      context: result.context,
      strategy: result.strategy,
      memory_count: result.memoryCount,
    };
    return {
      content: [{ type: "text", text: result.context }],
      structuredContent,
    };
  });

  server.registerTool("tdai_memory_capture", {
    title: "Capture completed turn",
    description: "Capture one completed user and assistant turn into long-term memory.",
    inputSchema: {
      user_content: z.string().min(1),
      assistant_content: z.string().min(1),
      session_key: z.string().min(1),
      session_id: z.string().optional(),
    },
    outputSchema: {
      l0_recorded: z.number().int().nonnegative(),
      scheduler_notified: z.boolean(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ user_content, assistant_content, session_key, session_id }) => {
    const result = await tools.capture({
      userContent: user_content,
      assistantContent: assistant_content,
      sessionKey: session_key,
      sessionId: session_id,
    });
    const structuredContent = {
      l0_recorded: result.l0Recorded,
      scheduler_notified: result.schedulerNotified,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  });

  server.registerTool("tdai_session_end", {
    title: "End memory session",
    description: "Flush buffered memory work for one session without stopping the Gateway.",
    inputSchema: {
      session_key: z.string().min(1),
    },
    outputSchema: {
      flushed: z.boolean(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ session_key }) => {
    const structuredContent = await tools.endSession({ sessionKey: session_key });
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  });

  server.registerTool("tdai_memory_search", {
    title: "Search structured memory",
    description: "Search L1 structured long-term memories.",
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(20).optional(),
      type: z.enum(["persona", "episodic", "instruction"]).optional(),
      scene: z.string().optional(),
    },
    outputSchema: {
      results: z.string(),
      total: z.number().int().nonnegative(),
      strategy: z.string(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ query, limit, type, scene }) => {
    const structuredContent = await tools.searchMemories({ query, limit, type, scene });
    return {
      content: [{ type: "text", text: structuredContent.results }],
      structuredContent,
    };
  });

  server.registerTool("tdai_conversation_search", {
    title: "Search conversation history",
    description: "Search L0 raw conversation messages for exact historical context.",
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(20).optional(),
      session_key: z.string().optional(),
    },
    outputSchema: {
      results: z.string(),
      total: z.number().int().nonnegative(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ query, limit, session_key }) => {
    const structuredContent = await tools.searchConversations({
      query,
      limit,
      sessionKey: session_key,
    });
    return {
      content: [{ type: "text", text: structuredContent.results }],
      structuredContent,
    };
  });

  return server;
}