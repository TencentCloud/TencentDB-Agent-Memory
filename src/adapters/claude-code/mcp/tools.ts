import { TdaiGatewayClient } from "../gateway-client.js";
import type {
  ClaudeCodeMcpToolName,
  ConversationSearchToolArgs,
  MemorySearchToolArgs,
} from "../types.js";

export interface ClaudeCodeMcpToolDefinition {
  name: ClaudeCodeMcpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const CLAUDE_CODE_MCP_TOOLS: ClaudeCodeMcpToolDefinition[] = [
  {
    name: "memory_tencentdb_memory_search",
    description: "Search TencentDB-Agent-Memory long-term L1 memories.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        limit: { type: "number", description: "Maximum result count." },
        type: { type: "string", description: "Optional memory type filter." },
        scene: { type: "string", description: "Optional scene filter." },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_tencentdb_conversation_search",
    description: "Search TencentDB-Agent-Memory L0 conversation history.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        limit: { type: "number", description: "Maximum result count." },
        session_key: { type: "string", description: "Optional session key filter." },
      },
      required: ["query"],
    },
  },
];

function requireQuery(args: unknown): string {
  if (!args || typeof args !== "object") throw new Error("Tool arguments must be an object");
  const query = (args as { query?: unknown }).query;
  if (typeof query !== "string" || query.trim() === "") throw new Error("`query` is required");
  return query.trim();
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export async function callClaudeCodeMcpTool(
  client: Pick<TdaiGatewayClient, "searchMemories" | "searchConversations">,
  name: string,
  args: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  if (name === "memory_tencentdb_memory_search") {
    const query = requireQuery(args);
    const raw = args as Partial<MemorySearchToolArgs>;
    const result = await client.searchMemories({
      query,
      limit: optionalNumber(raw.limit),
      type: optionalString(raw.type),
      scene: optionalString(raw.scene),
    });
    return {
      content: [{
        type: "text",
        text: [
          `TencentDB-Agent-Memory memory search`,
          `total=${result.total} strategy=${result.strategy}`,
          "",
          result.results,
        ].join("\n"),
      }],
    };
  }

  if (name === "memory_tencentdb_conversation_search") {
    const query = requireQuery(args);
    const raw = args as Partial<ConversationSearchToolArgs>;
    const result = await client.searchConversations({
      query,
      limit: optionalNumber(raw.limit),
      session_key: optionalString(raw.session_key),
    });
    return {
      content: [{
        type: "text",
        text: [
          `TencentDB-Agent-Memory conversation search`,
          `total=${result.total}`,
          "",
          result.results,
        ].join("\n"),
      }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

