import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createMemoryClient } from "./client.js";
import type { CursorConfig } from "./config.js";
import { isSafeScenarioPath } from "./context.js";

export interface CursorSearchClient {
  searchAtomic: (params: {
    query: string;
    limit?: number;
    type?: string;
  }) => Promise<unknown>;
  searchConversation: (params: {
    query: string;
    limit?: number;
    session_id?: string;
  }) => Promise<unknown>;
  readScenario: (params: { path: string }) => Promise<{
    path: string;
    content: string | null;
    created_at?: string | null;
    updated_at?: string | null;
  }>;
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

function success(value: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(value),
    }],
  };
}

function failure(label: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true as const,
    content: [{
      type: "text" as const,
      text: `${label}: ${message.slice(0, 300)}`,
    }],
  };
}

export function createCursorMcpServer(
  config: CursorConfig,
  client: CursorSearchClient = createMemoryClient(config),
): McpServer {
  const server = new McpServer({
    name: "tencentdb-memory-cursor",
    version: "1.0.0",
  });

  server.registerTool("tdai_memory_search", {
    description: "Search L1 structured long-term memory",
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().positive().max(100).optional(),
      type: z.string().optional(),
    },
    annotations: READ_ONLY_ANNOTATIONS,
  }, async ({ query, limit, type }) => {
    try {
      return success(await client.searchAtomic(compact({ query, limit, type })));
    } catch (error) {
      return failure("Memory search failed", error);
    }
  });

  server.registerTool("tdai_conversation_search", {
    description: "Search L0 conversation transcripts and evidence",
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().positive().max(100).optional(),
      session_key: z.string().min(1).optional(),
    },
    annotations: READ_ONLY_ANNOTATIONS,
  }, async ({ query, limit, session_key }) => {
    try {
      return success(await client.searchConversation(compact({
        query,
        limit,
        session_id: session_key,
      })));
    } catch (error) {
      return failure("Conversation search failed", error);
    }
  });

  server.registerTool("tdai_read_cos", {
    description: "Read one L2 scenario by its relative path",
    inputSchema: {
      path: z.string().min(1).refine(
        isSafeScenarioPath,
        "path must be a safe relative L2 scenario path",
      ),
    },
    annotations: READ_ONLY_ANNOTATIONS,
  }, async ({ path: scenarioPath }) => {
    try {
      const result = await client.readScenario({ path: scenarioPath });
      if (result.content === null) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Scenario not found: ${scenarioPath}`,
          }],
        };
      }
      return {
        content: [{ type: "text" as const, text: result.content }],
      };
    } catch (error) {
      return failure("Scenario read failed", error);
    }
  });

  return server;
}

export async function runCursorMcpServer(config: CursorConfig): Promise<void> {
  const server = createCursorMcpServer(config);
  await server.connect(new StdioServerTransport());
}
