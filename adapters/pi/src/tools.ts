import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { MemoryClientLike } from "./client.js";
import type { PiMemoryConfig } from "./config.js";
import { formatAtomicResults, formatConversationResults } from "./format.js";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionId(ctx: ExtensionContext): string {
  return "pi:" + ctx.sessionManager.getSessionId();
}

function setStatus(ctx: ExtensionContext, value: string): void {
  if (ctx.hasUI) ctx.ui.setStatus("tdai-memory", value);
}

function notify(ctx: ExtensionContext, value: string, level: "info" | "warning" | "error"): void {
  if (ctx.hasUI) ctx.ui.notify(value, level);
}

export function registerInvalidConfigStatusCommand(
  pi: ExtensionAPI,
  errors: string[],
): void {
  pi.registerCommand("tdai-memory-status", {
    description: "Show TencentDB Agent Memory adapter status",
    handler: async (_args, ctx) => {
      notify(ctx, "TencentDB memory is disabled: " + errors.join("; "), "warning");
    },
  });
}

export function registerMemoryToolsAndCommands(
  pi: ExtensionAPI,
  client: MemoryClientLike,
  config: PiMemoryConfig,
): void {
  pi.registerTool({
    name: "tdai_memory_search",
    label: "Search TencentDB memory",
    description: "Search long-term atomic memories stored in TencentDB Agent Memory.",
    promptSnippet: "Search durable user, project, and decision memories",
    promptGuidelines: [
      "Use tdai_memory_search when earlier preferences, decisions, or project facts may help.",
    ],
    parameters: Type.Object(
      {
        query: Type.String({ minLength: 1, description: "Semantic memory search query" }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal) {
      try {
        const items = await client.searchAtomic(
          params.query,
          params.limit ?? config.recallLimit,
          signal,
        );
        return {
          content: [{ type: "text", text: formatAtomicResults(items, config.maxContextChars) }],
          details: { count: items.length },
        };
      } catch (error) {
        throw new Error("Memory search failed: " + messageOf(error));
      }
    },
  });

  pi.registerTool({
    name: "tdai_conversation_search",
    label: "Search TencentDB conversations",
    description: "Search raw prior conversations stored in TencentDB Agent Memory.",
    promptSnippet: "Search prior user and assistant conversation text",
    promptGuidelines: [
      "Use tdai_conversation_search only when raw conversation evidence is needed.",
    ],
    parameters: Type.Object(
      {
        query: Type.String({ minLength: 1, description: "Conversation search query" }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        sessionOnly: Type.Optional(
          Type.Boolean({ description: "Limit results to the current Pi session" }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const items = await client.searchConversation(
          params.query,
          params.limit ?? config.recallLimit,
          params.sessionOnly ? sessionId(ctx) : undefined,
          signal,
        );
        return {
          content: [
            { type: "text", text: formatConversationResults(items, config.maxContextChars) },
          ],
          details: { count: items.length },
        };
      } catch (error) {
        throw new Error("Conversation search failed: " + messageOf(error));
      }
    },
  });

  pi.registerCommand("tdai-memory-status", {
    description: "Check TencentDB Agent Memory connectivity",
    handler: async (_args, ctx) => {
      try {
        const count = await client.check(ctx.signal);
        setStatus(ctx, "memory: online");
        if (count === null) {
          notify(ctx, "TencentDB memory is online (count unavailable).", "info");
        } else {
          notify(ctx, "TencentDB memory is online (" + count + " atomic memories).", "info");
        }
      } catch (error) {
        setStatus(ctx, "memory: offline");
        notify(ctx, "TencentDB memory check failed: " + messageOf(error), "error");
      }
    },
  });
}
