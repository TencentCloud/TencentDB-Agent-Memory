import type {
  CanonicalToolSpec,
  JsonSchemaObject,
  McpToolSpec,
  OpenClawToolSpec,
} from "./types.js";

const memorySearchDescription =
  "Search through the user's long-term memories. Use this when you need to recall " +
  "specific information about the user's preferences, past events, instructions, " +
  "or context from previous conversations. Returns relevant memory records ranked " +
  "by relevance. Limit: memory search and conversation search share a combined " +
  "limit of 3 calls per turn. Stop searching after 3 total attempts.";

const conversationSearchDescription =
  "Search through past conversation history (raw dialogue records). Use this when " +
  "structured memory search does not have the information you need, or when you " +
  "want to find specific past conversations, dialogue context, or exact words the " +
  "user said before. Returns relevant individual messages ranked by relevance. " +
  "Limit: memory search and conversation search share a combined limit of 3 calls " +
  "per turn. Stop searching after 3 total attempts.";

const emptyObjectSchema: JsonSchemaObject = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export const CANONICAL_MEMORY_TOOLS: readonly CanonicalToolSpec[] = [
  {
    id: "health",
    gatewayName: "memory_tencentdb_health",
    label: "Memory Gateway Health",
    description: "Check whether the memory-tencentdb Gateway is reachable.",
    inputSchema: emptyObjectSchema,
  },
  {
    id: "recall",
    gatewayName: "memory_tencentdb_recall",
    label: "Memory Recall",
    description: "Recall long-term memory context for a user query before answering.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "User query or current task text." },
        session_key: { type: "string", description: "Stable conversation/session key." },
        user_id: { type: "string", description: "Optional user identifier." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    id: "capture",
    gatewayName: "memory_tencentdb_capture",
    label: "Memory Capture",
    description: "Capture a completed user/assistant turn into memory.",
    inputSchema: {
      type: "object",
      properties: {
        user_content: { type: "string", description: "User message text." },
        assistant_content: { type: "string", description: "Assistant response text." },
        session_key: { type: "string", description: "Stable conversation/session key." },
        session_id: { type: "string", description: "Optional per-conversation session id." },
        user_id: { type: "string", description: "Optional user identifier." },
        messages: { type: "array", description: "Optional raw message array to preserve richer turn structure." },
      },
      required: ["user_content", "assistant_content"],
      additionalProperties: false,
    },
  },
  {
    id: "memory_search",
    gatewayName: "memory_tencentdb_memory_search",
    openclawName: "tdai_memory_search",
    label: "Memory Search",
    description: memorySearchDescription,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query describing what you want to recall about the user.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of results to return (default: 5, max: 20).",
        },
        type: {
          type: "string",
          enum: ["persona", "episodic", "instruction"],
          description: "Optional filter by memory type.",
        },
        scene: {
          type: "string",
          description: "Optional filter by scene name.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    id: "conversation_search",
    gatewayName: "memory_tencentdb_conversation_search",
    openclawName: "tdai_conversation_search",
    label: "Conversation Search",
    description: conversationSearchDescription,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query describing what conversation content you want to find.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of messages to return (default: 5, max: 20).",
        },
        session_key: {
          type: "string",
          description: "Optional session key filter.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    id: "session_end",
    gatewayName: "memory_tencentdb_session_end",
    label: "Memory Session End",
    description: "Flush buffered work for a session when the conversation ends.",
    inputSchema: {
      type: "object",
      properties: {
        session_key: { type: "string", description: "Session key to flush." },
        user_id: { type: "string", description: "Optional user identifier." },
      },
      additionalProperties: false,
    },
  },
] as const;

export function getCanonicalTool(id: CanonicalToolSpec["id"]): CanonicalToolSpec {
  const tool = CANONICAL_MEMORY_TOOLS.find((candidate) => candidate.id === id);
  if (!tool) throw new Error(`Unknown memory tool id: ${id}`);
  return tool;
}

export function getMcpToolDefinitions(): McpToolSpec[] {
  return CANONICAL_MEMORY_TOOLS.map((tool) => ({
    name: tool.gatewayName,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

export function getOpenClawSearchToolDefinitions(): OpenClawToolSpec[] {
  return CANONICAL_MEMORY_TOOLS
    .filter((tool) => tool.openclawName)
    .map((tool) => ({
      name: tool.openclawName!,
      label: tool.label,
      description: tool.description,
      parameters: tool.inputSchema,
    }));
}
