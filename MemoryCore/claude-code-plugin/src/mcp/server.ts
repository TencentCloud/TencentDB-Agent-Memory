/**
 * stdio MCP server: memory tools on the Gateway v3 API, wiki tools on the
 * Knowledge Service. Lifecycle hooks do the automatic recall and capture;
 * these tools are for on-demand detail and for explicit milestone captures.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { V3MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import { WIKI_PAGE_BATCH_LIMIT, type KnowledgeTools } from "../knowledge.js";

export interface McpServerOptions {
  memory: V3MemoryClient;
  knowledge?: KnowledgeTools;
  /** Session id used by tdai_memory_capture when the caller gives none. */
  defaultSessionId?: string;
}

const INSTRUCTIONS =
  "TencentDB Agent Memory tools for Claude Code. Lifecycle hooks already recall memory before each prompt and " +
  "capture each turn. Use the search tools when the injected memory does not answer the question, " +
  "tdai_memory_capture to record a milestone (a decision, a deploy, a lesson) in its own words, and the " +
  "wiki tools for settled team knowledge before exploring the filesystem.";

function textResult(text: string, structured?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], ...(structured ? { structuredContent: structured } : {}) };
}

function dataResult(data: unknown) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return textResult(text, data !== null && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : undefined);
}

export function createClaudeCodeMcpServer(options: McpServerOptions): McpServer {
  const { memory, knowledge } = options;
  const server = new McpServer({ name: "tdai-claude-code", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool("tdai_memory_search", {
    title: "Search structured memory",
    description: "Search L1 structured memories: preferences, past events, decisions, rules.",
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(20).optional(),
      type: z.enum(["persona", "episodic", "instruction"]).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ query, limit, type }) => {
    const result = await memory.searchAtomic({ query, limit: limit ?? 5, type });
    const items = result.items ?? [];
    if (items.length === 0) return textResult("No matching memories found.", { items: [] });
    const lines = [`Found ${items.length} matching memories:`, ""];
    for (const item of items) {
      const score = item.score != null ? ` (score: ${item.score.toFixed(3)})` : "";
      lines.push(`- **[${item.type}]**${score}`, `  ${item.content}`, "");
    }
    return textResult(lines.join("\n"), { items });
  });

  server.registerTool("tdai_conversation_search", {
    title: "Search conversation history",
    description: "Search L0 raw conversation messages, including captured tool calls and results.",
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(20).optional(),
      session_id: z.string().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ query, limit, session_id }) => {
    const result = await memory.searchConversation({ query, limit: limit ?? 5, session_id });
    const messages = result.messages ?? [];
    if (messages.length === 0) return textResult("No matching conversation messages found.", { messages: [] });
    const lines = [`Found ${messages.length} matching message(s):`, ""];
    for (const message of messages) {
      const score = message.score != null ? ` (score: ${message.score.toFixed(3)})` : "";
      const when = message.timestamp ? ` [${message.timestamp}]` : "";
      lines.push("---", `**[${message.role}]**${when}${score}`, "", message.content, "");
    }
    return textResult(lines.join("\n"), { messages });
  });

  server.registerTool("tdai_scenario_read", {
    title: "Read a scene block",
    description: "Read one L2 scene block by the path shown in Scene Navigation.",
    inputSchema: { path: z.string().min(1) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ path }) => {
    const file = await memory.readScenario({ path });
    return textResult(file.content ?? `(no scene block at ${path})`, { path: file.path, content: file.content });
  });

  server.registerTool("tdai_memory_capture", {
    title: "Capture a milestone",
    description:
      "Record a milestone in L0 in your own words: a ruling from the user, a merged change, a deploy, a lesson that cost time. " +
      "Hooks capture the transcript; this is for the summary other agents should find first.",
    inputSchema: {
      note: z.string().min(1).describe("What happened and why it matters, written for a reader with no context."),
      session_id: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ note, session_id }) => {
    const sessionId = session_id ?? options.defaultSessionId ?? `claude-code:${new Date().toISOString().slice(0, 10)}`;
    const result = await memory.addConversation({
      session_id: sessionId,
      messages: [{ role: "assistant", content: note }],
    });
    return textResult(`Captured (${result.accepted_ids?.length ?? 0} message).`, { session_id: sessionId, accepted_ids: result.accepted_ids });
  });

  if (knowledge) registerWikiTools(server, knowledge);
  return server;
}

const WIKI_ID = z.string().min(1).describe("Wiki id, from tdai_wiki_list.");
const WIKI_LIMIT = z.number().int().min(1).max(100).optional().describe("Max results (default 20, max 100).");

function registerWikiTools(server: McpServer, wiki: KnowledgeTools): void {
  server.registerTool("tdai_wiki_list", {
    title: "List wikis",
    description: "List the team wikis on the Knowledge Service. Returns wiki ids and names needed by every other wiki tool.",
    inputSchema: { limit: WIKI_LIMIT },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ limit }) => dataResult(await wiki.listWikis({ limit })));

  server.registerTool("tdai_wiki_search", {
    title: "Search a wiki",
    description: "Full-text search inside one team wiki: product docs, architecture, contracts, deploy recipes, decisions. Search here before hunting the filesystem.",
    inputSchema: { wiki_id: WIKI_ID, query: z.string().min(1), limit: WIKI_LIMIT },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ wiki_id, query, limit }) => dataResult(await wiki.searchWiki({ wikiId: wiki_id, query, limit })));

  server.registerTool("tdai_wiki_pages", {
    title: "List wiki pages",
    description: "List page refs in one team wiki.",
    inputSchema: { wiki_id: WIKI_ID, limit: WIKI_LIMIT },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ wiki_id, limit }) => dataResult(await wiki.listWikiPages({ wikiId: wiki_id, limit })));

  server.registerTool("tdai_wiki_read", {
    title: "Read wiki pages",
    description: `Read page contents from one team wiki (max ${WIKI_PAGE_BATCH_LIMIT} refs per call).`,
    inputSchema: { wiki_id: WIKI_ID, refs: z.array(z.string().min(1)).min(1).max(WIKI_PAGE_BATCH_LIMIT) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async ({ wiki_id, refs }) => dataResult(await wiki.readWikiPages({ wikiId: wiki_id, refs })));

  server.registerTool("tdai_wiki_write", {
    title: "Write wiki pages",
    description: `Create or update markdown pages in one team wiki (max ${WIKI_PAGE_BATCH_LIMIT} per call). Read the existing page first and amend it; a locked page fails with a lock error, so retry.`,
    inputSchema: {
      wiki_id: WIKI_ID,
      pages: z.array(z.object({ ref: z.string().min(1), content: z.string() })).min(1).max(WIKI_PAGE_BATCH_LIMIT),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }, async ({ wiki_id, pages }) => dataResult(await wiki.writeWikiPages({ wikiId: wiki_id, pages })));
}
