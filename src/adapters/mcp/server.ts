import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { createMemoryTools } from "./tools.js";
import type { MemoryGatewayOptions } from "./gateway.js";
import { createKnowledgeTools, WIKI_PAGE_BATCH_LIMIT, type KnowledgeServiceOptions } from "./knowledge.js";

const SERVER_INSTRUCTIONS =
  "TencentDB Agent Memory tools. Lifecycle hooks perform automatic recall and capture. " +
  "Use search tools only when additional historical context is needed, and do not capture a turn twice. " +
  "Wiki tools reach the team Knowledge Service: settled documentation, architecture, contracts, and decisions. " +
  "Search the wiki before exploring the filesystem for where things live or how a team does something.";

export interface MemoryMcpServerOptions extends MemoryGatewayOptions {
  /**
   * Knowledge Service (wiki) configuration. Omit to read it from `TDAI_KNOWLEDGE_*`
   * environment variables; pass `false` to register memory tools only.
   * `fetch` falls back to the Gateway value when not set here.
   */
  knowledge?: KnowledgeServiceOptions | false;
}

function wikiToolResult(data: unknown) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    ...(data !== null && typeof data === "object" && !Array.isArray(data)
      ? { structuredContent: data as Record<string, unknown> }
      : {}),
  };
}

export function createMemoryMcpServer(options: MemoryMcpServerOptions = {}): McpServer {
  const { knowledge: knowledgeOptions, ...gatewayOptions } = options;
  const tools = createMemoryTools(gatewayOptions);
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

  if (knowledgeOptions !== false) {
    registerWikiTools(server, {
      fetch: gatewayOptions.fetch,
      ...(knowledgeOptions ?? {}),
    });
  }

  return server;
}

const WIKI_ID_SCHEMA = z.string().min(1).describe("Wiki id, from tdai_wiki_list.");
const WIKI_LIMIT_SCHEMA = z.number().int().min(1).max(100).optional().describe("Max results (default 20, max 100).");

function registerWikiTools(server: McpServer, options: KnowledgeServiceOptions): void {
  const wiki = createKnowledgeTools(options);

  server.registerTool("tdai_wiki_list", {
    title: "List wikis",
    description: "List the team wikis on the Knowledge Service. Returns wiki ids and names needed by every other wiki tool.",
    inputSchema: {
      limit: WIKI_LIMIT_SCHEMA,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ limit }) => wikiToolResult(await wiki.listWikis({ limit })));

  server.registerTool("tdai_wiki_search", {
    title: "Search a wiki",
    description:
      "Full-text search inside one team wiki. Wikis hold settled knowledge: product docs, architecture, " +
      "contracts, deploy recipes, and decisions. Search here before hunting the filesystem.",
    inputSchema: {
      wiki_id: WIKI_ID_SCHEMA,
      query: z.string().min(1).describe("Search query."),
      limit: WIKI_LIMIT_SCHEMA,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ wiki_id, query, limit }) => wikiToolResult(await wiki.searchWiki({ wikiId: wiki_id, query, limit })));

  server.registerTool("tdai_wiki_pages", {
    title: "List wiki pages",
    description: "List page refs in one team wiki.",
    inputSchema: {
      wiki_id: WIKI_ID_SCHEMA,
      limit: WIKI_LIMIT_SCHEMA,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ wiki_id, limit }) => wikiToolResult(await wiki.listWikiPages({ wikiId: wiki_id, limit })));

  server.registerTool("tdai_wiki_read", {
    title: "Read wiki pages",
    description: `Read page contents from one team wiki. Refs come from tdai_wiki_pages or tdai_wiki_search (max ${WIKI_PAGE_BATCH_LIMIT} per call).`,
    inputSchema: {
      wiki_id: WIKI_ID_SCHEMA,
      refs: z.array(z.string().min(1)).min(1).max(WIKI_PAGE_BATCH_LIMIT).describe("Page refs to read."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ wiki_id, refs }) => wikiToolResult(await wiki.readWikiPages({ wikiId: wiki_id, refs })));

  server.registerTool("tdai_wiki_write", {
    title: "Write wiki pages",
    description:
      `Create or update markdown pages in one team wiki (max ${WIKI_PAGE_BATCH_LIMIT} per call). ` +
      "Read the existing page first and amend it; a page locked by a concurrent write fails with a lock error, so retry.",
    inputSchema: {
      wiki_id: WIKI_ID_SCHEMA,
      pages: z.array(z.object({
        ref: z.string().min(1).describe("Page ref or path."),
        content: z.string().describe("Full markdown content of the page."),
      })).min(1).max(WIKI_PAGE_BATCH_LIMIT).describe("Pages to write."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }, async ({ wiki_id, pages }) => wikiToolResult(await wiki.writeWikiPages({ wikiId: wiki_id, pages })));
}