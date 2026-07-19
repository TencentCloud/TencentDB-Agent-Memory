/**
 * buildMemoryTools — turn a {@link MemoryAdapter} into platform-neutral tool
 * descriptors.
 *
 * This is what makes "add a new platform in ~30 lines" true. Every agent
 * host — MCP, Dify, LangChain, an OpenAI function-calling loop — ultimately
 * needs the same thing: a list of tools with a name, a description, a JSON
 * Schema for the arguments, and an `invoke(args)` that returns text. This
 * module produces exactly that, once, from the adapter. A platform adapter
 * then only has to map `MemoryTool` onto its host's tool type.
 *
 * Design choices that keep platform code trivial:
 *   - `inputSchema` is plain JSON Schema (Draft 2020-12) — MCP, Dify, and
 *     OpenAI all consume it directly.
 *   - `invoke` never throws. Failures come back as `{ isError: true, text }`
 *     so a flaky Gateway degrades to a readable message instead of crashing
 *     the host's tool loop (mirrors the Hermes provider's behavior).
 *   - Argument coercion (limit clamping, missing-query guards) lives here so
 *     no platform has to re-implement it — LLMs routinely send `"10"` or
 *     `10.5` for an integer field.
 */

import type {
  MemoryAdapter,
  MemorySearchResult,
  ConversationSearchResult,
} from "./memory-adapter.js";

// ============================
// Types
// ============================

/** Minimal JSON Schema shape (Draft 2020-12) — enough for tool arguments. */
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface MemoryToolResult {
  /** Text payload for the model / user. */
  text: string;
  /** Structured payload for hosts that support structured tool output. */
  data?: unknown;
  /** True when the tool failed; `text` carries a readable error message. */
  isError?: boolean;
}

/** A self-contained, host-neutral tool descriptor. */
export interface MemoryTool {
  /** Stable tool id (e.g. "tdai_memory_search"). */
  name: string;
  /** Short human-facing label. */
  title: string;
  /** Model-facing description (when and why to call this tool). */
  description: string;
  /** JSON Schema for the tool arguments. */
  inputSchema: JsonSchema;
  /** Execute the tool. Never rejects — failures return `{ isError: true }`. */
  invoke(args: Record<string, unknown>): Promise<MemoryToolResult>;
}

export interface BuildMemoryToolsOptions {
  /**
   * Session key used by recall/capture when the caller doesn't supply one.
   * Tool platforms are frequently stateless per call, so a stable default
   * keeps L0/L1 grouping coherent. Default: "default".
   */
  sessionKey?: string;
  /** Include the `tdai_capture` write tool. Default: true. */
  includeCapture?: boolean;
  /** Include the `tdai_recall` context tool. Default: true. */
  includeRecall?: boolean;
  /** Prefix applied to every tool name (e.g. "memory_"). Default: none. */
  namePrefix?: string;
}

// ============================
// Argument coercion helpers
// ============================

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

/**
 * Coerce an LLM-supplied `limit` into an int in [1, max]. LLMs ignore the
 * `type: integer` hint and send strings ("10"), floats (10.5), null, or
 * booleans; this mirrors the Python provider's `_coerce_limit`.
 */
export function coerceLimit(raw: unknown, def = DEFAULT_LIMIT, max = MAX_LIMIT): number {
  if (raw === null || raw === undefined || raw === "") return def;
  if (typeof raw === "boolean") return def;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return def;
  const truncated = Math.trunc(n);
  if (truncated < 1) return 1;
  if (truncated > max) return max;
  return truncated;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new ToolArgError(`Missing or empty required parameter: ${key}`);
  }
  return v;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

class ToolArgError extends Error {}

/** Wrap a handler so it never throws across the host boundary. */
function guard(
  handler: (args: Record<string, unknown>) => Promise<MemoryToolResult>,
): (args: Record<string, unknown>) => Promise<MemoryToolResult> {
  return async (args) => {
    try {
      return await handler(args ?? {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { text: message, isError: true };
    }
  };
}

// ============================
// buildMemoryTools
// ============================

/**
 * Produce the canonical TDAI memory tools bound to `adapter`.
 *
 * Read tools (always): `tdai_memory_search`, `tdai_conversation_search`.
 * Context tool (opt-out): `tdai_recall`.
 * Write tool (opt-out): `tdai_capture`.
 */
export function buildMemoryTools(
  adapter: MemoryAdapter,
  opts: BuildMemoryToolsOptions = {},
): MemoryTool[] {
  const sessionKey = opts.sessionKey ?? "default";
  const prefix = opts.namePrefix ?? "";
  const name = (base: string) => `${prefix}${base}`;

  const tools: MemoryTool[] = [];

  // -- memory_search (read) -----------------------------------------------
  tools.push({
    name: name("tdai_memory_search"),
    title: "Search long-term memories",
    description:
      "Search the user's long-term structured memories (L1). Use this to recall " +
      "the user's preferences, past events, instructions, or context from earlier " +
      "conversations. Returns memory records ranked by relevance.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you want to recall about the user." },
        limit: { type: "integer", description: "Max results (default 5, max 20)." },
        type: {
          type: "string",
          enum: ["persona", "episodic", "instruction"],
          description: "Optional filter by memory type.",
        },
        scene: { type: "string", description: "Optional scene-block filter." },
      },
      required: ["query"],
    },
    invoke: guard(async (args) => {
      const result: MemorySearchResult = await adapter.searchMemories({
        query: requireString(args, "query"),
        limit: coerceLimit(args.limit),
        type: optionalString(args, "type"),
        scene: optionalString(args, "scene"),
      });
      return { text: result.text, data: result };
    }),
  });

  // -- conversation_search (read) -----------------------------------------
  tools.push({
    name: name("tdai_conversation_search"),
    title: "Search conversation history",
    description:
      "Search past raw conversation history (L0). Use this when memory search " +
      "does not have what you need, or when you want the exact words the user " +
      "said before.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What conversation content to find." },
        limit: { type: "integer", description: "Max messages (default 5, max 20)." },
        session_key: { type: "string", description: "Optional: restrict to one session." },
      },
      required: ["query"],
    },
    invoke: guard(async (args) => {
      const result: ConversationSearchResult = await adapter.searchConversations({
        query: requireString(args, "query"),
        limit: coerceLimit(args.limit),
        sessionKey: optionalString(args, "session_key"),
      });
      return { text: result.text, data: result };
    }),
  });

  // -- recall (read / context) --------------------------------------------
  if (opts.includeRecall !== false) {
    tools.push({
      name: name("tdai_recall"),
      title: "Recall memory context",
      description:
        "Fetch the recall context block (relevant memories + persona) for a query, " +
        "as the memory engine would inject it before an LLM turn. Useful to prime a " +
        "response with what is known about the user.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The user's current query or intent." },
          session_key: { type: "string", description: "Session id (defaults to the adapter's session)." },
        },
        required: ["query"],
      },
      invoke: guard(async (args) => {
        const result = await adapter.recall({
          query: requireString(args, "query"),
          sessionKey: optionalString(args, "session_key") ?? sessionKey,
        });
        return {
          text: result.context || "(no relevant memory context)",
          data: result,
        };
      }),
    });
  }

  // -- capture (write) -----------------------------------------------------
  if (opts.includeCapture !== false) {
    tools.push({
      name: name("tdai_capture"),
      title: "Capture a conversation turn",
      description:
        "Persist a completed user/assistant turn into memory (L0 → pipeline). " +
        "Call this after a meaningful exchange so it can be structured and recalled later.",
      inputSchema: {
        type: "object",
        properties: {
          user_content: { type: "string", description: "The user's message." },
          assistant_content: { type: "string", description: "The assistant's reply." },
          session_key: { type: "string", description: "Session id (defaults to the adapter's session)." },
        },
        required: ["user_content", "assistant_content"],
      },
      invoke: guard(async (args) => {
        const result = await adapter.capture({
          userContent: requireString(args, "user_content"),
          assistantContent: requireString(args, "assistant_content"),
          sessionKey: optionalString(args, "session_key") ?? sessionKey,
        });
        return {
          text: `Captured turn: ${result.l0Recorded} message(s) recorded, ` +
            `scheduler ${result.schedulerNotified ? "notified" : "idle"}.`,
          data: result,
        };
      }),
    });
  }

  return tools;
}
