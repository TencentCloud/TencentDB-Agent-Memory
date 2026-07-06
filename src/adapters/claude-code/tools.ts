/**
 * Claude Code adapter — MCP tool definitions + dispatch onto `MemoryClient`.
 *
 * Five tools cover the full TdaiCore capability surface:
 *
 *   memory_recall       → client.recall              (context prefetch)
 *   memory_capture      → client.capture             (explicit turn write)
 *   memory_search       → client.searchMemories      (L1 structured memories)
 *   conversation_search → client.searchConversations (L0 raw history)
 *   memory_session_end  → client.endSession          (flush one session)
 *
 * Argument names are snake_case, matching the Gateway wire vocabulary
 * (`session_key`, `user_content`, …) so operators see one consistent naming
 * scheme across HTTP, Python, and MCP surfaces. Model-facing descriptions for
 * the two search tools reuse the wording of the OpenClaw registrations in
 * root `index.ts` so model guidance stays consistent across platforms.
 */

import type { MemoryClient } from "../../adapter-sdk/index.js";

// ============================
// Tool definitions (MCP `tools/list` payload)
// ============================

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const SESSION_KEY_PROPERTY = {
  type: "string",
  description: "Optional: override the server's default session key",
} as const;

export const TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: "memory_recall",
    description:
      "Retrieve the user's memory context relevant to a query — persona profile, scene navigation, " +
      "and the most relevant long-term memories. Use this at the start of a task to load what is " +
      "already known about the user before answering.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The user's current question or topic to recall memory context for",
        },
        session_key: SESSION_KEY_PROPERTY,
      },
      required: ["query"],
    },
  },
  {
    name: "memory_capture",
    description:
      "Save one completed conversation turn (user message + assistant reply) into long-term memory. " +
      "Call this after an exchange worth remembering — preferences the user stated, decisions made, " +
      "facts learned. The memory engine will archive the raw turn and asynchronously extract " +
      "structured memories from it.",
    inputSchema: {
      type: "object",
      properties: {
        user_content: {
          type: "string",
          description: "The user's message text for the turn",
        },
        assistant_content: {
          type: "string",
          description: "The assistant's reply text for the turn",
        },
        session_key: SESSION_KEY_PROPERTY,
      },
      required: ["user_content", "assistant_content"],
    },
  },
  {
    name: "memory_search",
    description:
      "Search through the user's long-term memories. Use this when you need to recall specific " +
      "information about the user's preferences, past events, instructions, or context from previous " +
      "conversations. Returns relevant memory records ranked by relevance.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query describing what you want to recall about the user",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default: 5, max: 20)",
        },
        type: {
          type: "string",
          enum: ["persona", "episodic", "instruction"],
          description:
            "Optional filter by memory type: persona (identity/preferences), episodic (events/activities), " +
            "instruction (user rules/commands)",
        },
        scene: {
          type: "string",
          description: "Optional filter by scene name",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "conversation_search",
    description:
      "Search through past conversation history (raw dialogue records). Use this when memory_search " +
      "(structured memories) doesn't have the information you need, or when you want to find specific " +
      "past conversations, dialogue context, or exact words the user said before. Returns relevant " +
      "individual messages ranked by relevance.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query describing what conversation content you want to find",
        },
        limit: {
          type: "number",
          description: "Maximum number of messages to return (default: 5, max: 20)",
        },
        session_key: {
          type: "string",
          description: "Optional: filter results to a specific session",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_session_end",
    description:
      "Flush this session's buffered memory work (finalize pending extraction for the session). " +
      "Call when a work session is wrapping up. Other sessions are unaffected.",
    inputSchema: {
      type: "object",
      properties: {
        session_key: SESSION_KEY_PROPERTY,
      },
    },
  },
];

// ============================
// Dispatch
// ============================

export interface ToolDispatchContext {
  client: MemoryClient;
  /** Session key used when a tool call does not override it. */
  defaultSessionKey: string;
  userId?: string;
}

export class UnknownToolError extends Error {
  constructor(name: string) {
    super(`Unknown tool: ${name}`);
    this.name = "UnknownToolError";
  }
}

/** Clamp `limit` to 1..20 with default 5 — identical to root index.ts tools. */
export function clampLimit(raw: unknown): number {
  return Math.min(Math.max(Number(raw) || 5, 1), 20);
}

function strArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}

/**
 * Execute one MCP tool call against the MemoryClient and return the text
 * payload for the `tools/call` result.
 *
 * Throws `UnknownToolError` for unregistered names (the server maps it to
 * JSON-RPC `-32602`); any other rejection is a tool-level failure the server
 * reports as `isError: true` per the MCP spec.
 */
export async function dispatchToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolDispatchContext,
): Promise<string> {
  const sessionKey = strArg(args, "session_key") ?? ctx.defaultSessionKey;

  switch (name) {
    case "memory_recall": {
      const query = String(args.query ?? "");
      const outcome = await ctx.client.recall({ query, sessionKey, userId: ctx.userId });
      const parts = [outcome.prependContext, outcome.context].filter(
        (p): p is string => typeof p === "string" && p.trim().length > 0,
      );
      if (parts.length === 0) return "No relevant memories found.";
      return parts.join("\n\n");
    }

    case "memory_capture": {
      const userContent = String(args.user_content ?? "");
      const assistantContent = String(args.assistant_content ?? "");
      const outcome = await ctx.client.capture({
        userContent,
        assistantContent,
        sessionKey,
        userId: ctx.userId,
      });
      return `Captured: l0_recorded=${outcome.l0Recorded}, scheduler_notified=${outcome.schedulerNotified}`;
    }

    case "memory_search": {
      const outcome = await ctx.client.searchMemories({
        query: String(args.query ?? ""),
        limit: clampLimit(args.limit),
        type: strArg(args, "type"),
        scene: strArg(args, "scene"),
      });
      return outcome.text;
    }

    case "conversation_search": {
      const outcome = await ctx.client.searchConversations({
        query: String(args.query ?? ""),
        limit: clampLimit(args.limit),
        sessionKey: strArg(args, "session_key"),
      });
      return outcome.text;
    }

    case "memory_session_end": {
      await ctx.client.endSession(sessionKey);
      return `Session flushed: ${sessionKey}`;
    }

    default:
      throw new UnknownToolError(name);
  }
}
