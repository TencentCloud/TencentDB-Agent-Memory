import { z } from "zod";

import type { MemoryService } from "../gateway/types.js";

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface McpToolRegistrar {
  registerTool(
    name: string,
    definition: {
      description: string;
      inputSchema: Record<string, z.ZodType>;
      annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
      };
    },
    handler: (args: Record<string, unknown>) => Promise<McpToolResult>,
  ): unknown;
}

export interface MemoryToolDefaults {
  sessionKey?: string;
  userId?: string;
}

const querySchema = z.string().min(1).describe("Natural-language memory query.");
const sessionKeySchema = z.string().min(1).optional().describe(
  "Stable conversation or project session key. Uses TDAI_MCP_SESSION_KEY when omitted.",
);
const userIdSchema = z.string().min(1).optional().describe(
  "Optional user identity. Uses TDAI_MCP_USER_ID when omitted.",
);
const limitSchema = z.number().int().min(1).max(20).optional().describe(
  "Maximum number of results (1-20, default 5).",
);

function jsonResult(value: unknown): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error: unknown): McpToolResult {
  return {
    content: [{
      type: "text",
      text: error instanceof Error ? error.message : String(error),
    }],
    isError: true,
  };
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolveSessionKey(
  args: Record<string, unknown>,
  defaults: MemoryToolDefaults,
): string {
  const sessionKey = optionalString(args, "session_key") ?? defaults.sessionKey;
  if (!sessionKey) {
    throw new Error(
      "Missing session_key. Pass it to this tool or set TDAI_MCP_SESSION_KEY when starting the MCP server.",
    );
  }
  return sessionKey;
}

function resolveUserId(
  args: Record<string, unknown>,
  defaults: MemoryToolDefaults,
): string | undefined {
  return optionalString(args, "user_id") ?? defaults.userId;
}

async function invoke(operation: () => Promise<unknown>): Promise<McpToolResult> {
  try {
    return jsonResult(await operation());
  } catch (error) {
    return errorResult(error);
  }
}

/**
 * Register the shared TDAI memory tools on any MCP-compatible registrar.
 */
export function registerMemoryTools(
  registrar: McpToolRegistrar,
  service: MemoryService,
  defaults: MemoryToolDefaults = {},
): void {
  registrar.registerTool(
    "tdai_health",
    {
      description: "Check whether the TencentDB Agent Memory Gateway and its stores are available.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => invoke(() => service.health()),
  );

  registrar.registerTool(
    "tdai_recall",
    {
      description:
        "Recall relevant long-term memory context before answering a user request. " +
        "Use this proactively when prior preferences, decisions, or project context may matter.",
      inputSchema: {
        query: querySchema,
        session_key: sessionKeySchema,
        user_id: userIdSchema,
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => invoke(async () => {
      const result = await service.recall({
        query: String(args.query),
        sessionKey: resolveSessionKey(args, defaults),
        userId: resolveUserId(args, defaults),
      });
      return {
        context: result.context,
        strategy: result.strategy,
        memory_count: result.memoryCount,
      };
    }),
  );

  registrar.registerTool(
    "tdai_capture",
    {
      description:
        "Persist one completed user/assistant turn into TencentDB Agent Memory. " +
        "Call after a meaningful turn to build cross-session memory.",
      inputSchema: {
        user_content: z.string().min(1).describe("The user's original message."),
        assistant_content: z.string().min(1).describe("The assistant's completed response."),
        session_key: sessionKeySchema,
        session_id: z.string().min(1).optional().describe("Optional turn or sub-session identifier."),
        user_id: userIdSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => invoke(async () => {
      const result = await service.capture({
        userContent: String(args.user_content),
        assistantContent: String(args.assistant_content),
        sessionKey: resolveSessionKey(args, defaults),
        sessionId: optionalString(args, "session_id"),
        userId: resolveUserId(args, defaults),
      });
      return {
        l0_recorded: result.l0Recorded,
        scheduler_notified: result.schedulerNotified,
      };
    }),
  );

  registrar.registerTool(
    "tdai_memory_search",
    {
      description:
        "Search L1 structured memories for preferences, events, instructions, or prior decisions.",
      inputSchema: {
        query: querySchema,
        limit: limitSchema,
        type: z.enum(["persona", "episodic", "instruction"]).optional().describe(
          "Optional structured memory type.",
        ),
        scene: z.string().min(1).optional().describe("Optional scene name filter."),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => invoke(async () => {
      const result = await service.searchMemories({
        query: String(args.query),
        limit: typeof args.limit === "number" ? args.limit : undefined,
        type: optionalString(args, "type"),
        scene: optionalString(args, "scene"),
      });
      return {
        results: result.results,
        total: result.total,
        strategy: result.strategy,
      };
    }),
  );

  registrar.registerTool(
    "tdai_conversation_search",
    {
      description:
        "Search L0 raw conversation history when exact wording or evidence from a prior turn is needed.",
      inputSchema: {
        query: querySchema,
        limit: limitSchema,
        session_key: sessionKeySchema,
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => invoke(async () => {
      const result = await service.searchConversations({
        query: String(args.query),
        limit: typeof args.limit === "number" ? args.limit : undefined,
        sessionKey: optionalString(args, "session_key") ?? defaults.sessionKey,
      });
      return {
        results: result.results,
        total: result.total,
      };
    }),
  );

  registrar.registerTool(
    "tdai_session_end",
    {
      description:
        "Flush pending memory pipeline work for one session when the host session is ending.",
      inputSchema: {
        session_key: sessionKeySchema,
        user_id: userIdSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => invoke(async () => {
      const result = await service.endSession({
        sessionKey: resolveSessionKey(args, defaults),
        userId: resolveUserId(args, defaults),
      });
      return { flushed: result.flushed };
    }),
  );
}
