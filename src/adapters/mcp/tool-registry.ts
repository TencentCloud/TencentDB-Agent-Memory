import type { CaptureResult, CompletedTurn, ConversationSearchParams, MemorySearchParams, RecallResult } from "../../core/types.js";

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  resultType: "complete";
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface TdaiMcpCore {
  handleBeforeRecall(userText: string, sessionKey: string): Promise<RecallResult>;
  handleTurnCommitted(turn: CompletedTurn): Promise<CaptureResult>;
  searchMemories(params: MemorySearchParams): Promise<{ text: string; total: number; strategy: string }>;
  searchConversations(params: ConversationSearchParams): Promise<{ text: string; total: number }>;
  handleSessionEnd(sessionKey: string): Promise<void>;
}

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  additionalProperties: false,
  properties,
  ...(required.length > 0 ? { required } : {}),
});

export const TDAI_MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "tdai_recall",
    title: "TDAI Recall",
    description:
      "Recall relevant long-term memory context before answering a user. Use this at the start of a turn when past preferences, facts, or instructions may matter.",
    inputSchema: objectSchema({
      query: {
        type: "string",
        description: "Current user request or recall query.",
      },
      session_key: {
        type: "string",
        description: "Stable conversation/session key used to scope recall.",
      },
    }, ["query", "session_key"]),
  },
  {
    name: "tdai_capture",
    title: "TDAI Capture",
    description:
      "Capture a completed user/assistant turn into TDAI memory. Call this after a successful response so future turns can recall it.",
    inputSchema: objectSchema({
      user_content: {
        type: "string",
        description: "The user's message for the completed turn.",
      },
      assistant_content: {
        type: "string",
        description: "The assistant's answer for the completed turn.",
      },
      session_key: {
        type: "string",
        description: "Stable conversation/session key used to group memory.",
      },
      session_id: {
        type: "string",
        description: "Optional host-specific session identifier.",
      },
      messages: {
        type: "array",
        description: "Optional raw message list. When omitted, a two-message user/assistant turn is synthesized.",
        items: { type: "object" },
      },
    }, ["user_content", "assistant_content", "session_key"]),
  },
  {
    name: "tdai_memory_search",
    title: "TDAI Memory Search",
    description:
      "Search structured L1 long-term memories. Prefer this for user preferences, instructions, persona facts, and summarized past events.",
    inputSchema: objectSchema({
      query: {
        type: "string",
        description: "Search query describing what memory to find.",
      },
      limit: {
        type: "number",
        description: "Maximum number of results, default 5 and max 20.",
      },
      type: {
        type: "string",
        enum: ["persona", "episodic", "instruction"],
        description: "Optional memory type filter.",
      },
      scene: {
        type: "string",
        description: "Optional scene name filter.",
      },
    }, ["query"]),
  },
  {
    name: "tdai_conversation_search",
    title: "TDAI Conversation Search",
    description:
      "Search raw L0 conversation history. Use this when structured memories are insufficient or exact prior wording matters.",
    inputSchema: objectSchema({
      query: {
        type: "string",
        description: "Search query describing what conversation content to find.",
      },
      limit: {
        type: "number",
        description: "Maximum number of messages, default 5 and max 20.",
      },
      session_key: {
        type: "string",
        description: "Optional session filter.",
      },
    }, ["query"]),
  },
  {
    name: "tdai_session_end",
    title: "TDAI Session End",
    description:
      "Flush pending memory pipeline work for a single session without shutting down the MCP server.",
    inputSchema: objectSchema({
      session_key: {
        type: "string",
        description: "Session key whose pending memory work should be flushed.",
      },
    }, ["session_key"]),
  },
];

export async function executeTdaiMcpTool(
  core: TdaiMcpCore,
  name: string,
  args: Record<string, unknown> = {},
): Promise<McpToolResult> {
  switch (name) {
    case "tdai_recall":
      return recall(core, args);
    case "tdai_capture":
      return capture(core, args);
    case "tdai_memory_search":
      return memorySearch(core, args);
    case "tdai_conversation_search":
      return conversationSearch(core, args);
    case "tdai_session_end":
      return sessionEnd(core, args);
    default:
      throw new Error(`Unknown TDAI MCP tool: ${name}`);
  }
}

async function recall(core: TdaiMcpCore, args: Record<string, unknown>): Promise<McpToolResult> {
  const query = requireString(args, "query");
  const sessionKey = requireString(args, "session_key");
  const result = await core.handleBeforeRecall(query, sessionKey);
  const context = joinRecallContext(result);
  const structuredContent = {
    context,
    appendSystemContext: result.appendSystemContext ?? "",
    prependContext: result.prependContext ?? "",
    strategy: result.recallStrategy,
    memory_count: result.recalledL1Memories?.length ?? 0,
    persona_present: !!result.recalledL3Persona,
  };

  return textResult(context || "No relevant memory found.", structuredContent);
}

async function capture(core: TdaiMcpCore, args: Record<string, unknown>): Promise<McpToolResult> {
  const userText = requireString(args, "user_content");
  const assistantText = requireString(args, "assistant_content");
  const sessionKey = requireString(args, "session_key");
  const sessionId = optionalString(args, "session_id");
  const rawMessages = Array.isArray(args.messages) ? args.messages : undefined;
  const messages = rawMessages ?? [
    { role: "user", content: userText },
    { role: "assistant", content: assistantText },
  ];

  const result = await core.handleTurnCommitted({
    userText,
    assistantText,
    messages,
    sessionKey,
    sessionId,
    startedAt: Date.now(),
  });
  const structuredContent = {
    l0_recorded: result.l0RecordedCount,
    scheduler_notified: result.schedulerNotified,
    l0_vectors_written: result.l0VectorsWritten,
  };

  return textResult(
    `Captured ${result.l0RecordedCount} L0 message(s); scheduler_notified=${result.schedulerNotified}.`,
    structuredContent,
  );
}

async function memorySearch(core: TdaiMcpCore, args: Record<string, unknown>): Promise<McpToolResult> {
  const result = await core.searchMemories({
    query: requireString(args, "query"),
    limit: optionalPositiveInt(args, "limit", 5, 20),
    type: optionalString(args, "type"),
    scene: optionalString(args, "scene"),
  });
  return textResult(result.text, {
    results: result.text,
    total: result.total,
    strategy: result.strategy,
  });
}

async function conversationSearch(core: TdaiMcpCore, args: Record<string, unknown>): Promise<McpToolResult> {
  const result = await core.searchConversations({
    query: requireString(args, "query"),
    limit: optionalPositiveInt(args, "limit", 5, 20),
    sessionKey: optionalString(args, "session_key"),
  });
  return textResult(result.text, {
    results: result.text,
    total: result.total,
  });
}

async function sessionEnd(core: TdaiMcpCore, args: Record<string, unknown>): Promise<McpToolResult> {
  const sessionKey = requireString(args, "session_key");
  await core.handleSessionEnd(sessionKey);
  return textResult(`Flushed pending memory work for session ${sessionKey}.`, {
    flushed: true,
    session_key: sessionKey,
  });
}

function joinRecallContext(result: RecallResult): string {
  return [result.appendSystemContext, result.prependContext]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n\n");
}

function textResult(text: string, structuredContent?: unknown): McpToolResult {
  return {
    resultType: "complete",
    content: [{ type: "text", text }],
    structuredContent,
    isError: false,
  };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required string argument: ${key}`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalPositiveInt(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const raw = args[key];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}
