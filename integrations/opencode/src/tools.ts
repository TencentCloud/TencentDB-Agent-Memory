import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { MemoryService } from "./memory-service.js";
import type { OpenCodeMemoryRuntime } from "./plugin-runtime.js";
import { stripRecallBlocks } from "./message-codec.js";

function limit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Math.min(50, Math.max(1, Math.trunc(value)));
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeMessages(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message))
      return message;
    const copy = { ...(message as Record<string, unknown>) };
    delete copy.timestamp;
    if (typeof copy.content === "string")
      copy.content = stripRecallBlocks(copy.content);
    return copy;
  });
}

export function createMemoryTools(
  runtime: OpenCodeMemoryRuntime,
  service: MemoryService,
): Record<string, ToolDefinition> {
  const z = tool.schema;
  const unavailable = (action: string, error: unknown): string =>
    runtime.formatter.unavailable(action, reason(error));

  return {
    agent_memory_health: tool({
      description:
        "Check whether TencentDB Agent Memory and its Gateway stores are available.",
      args: {},
      async execute() {
        try {
          return runtime.formatter.health(
            await service.run(() => service.client.health()),
          );
        } catch (error) {
          return unavailable("health check", error);
        }
      },
    }),

    agent_memory_recall: tool({
      description:
        "Recall relevant long-term memory for the current OpenCode task.",
      args: {
        query: z.string().min(1),
        session_key: z.string().optional(),
        user_id: z.string().optional(),
      },
      async execute(args, context) {
        try {
          const result = await service.run(() =>
            service.client.recall({
              query: args.query.trim(),
              session_key: runtime.resolveSession(
                context.sessionID,
                args.session_key,
              ),
              user_id: runtime.userId(args.user_id),
            }),
          );
          return runtime.formatter.recall(result);
        } catch (error) {
          return unavailable("recall", error);
        }
      },
    }),

    agent_memory_capture: tool({
      description:
        "Capture a completed task, decision, or meaningful conversation turn into Agent Memory.",
      args: {
        user_content: z.string().min(1),
        assistant_content: z.string().min(1),
        session_key: z.string().optional(),
        session_id: z.string().optional(),
        user_id: z.string().optional(),
        messages: z.array(z.any()).optional(),
      },
      async execute(args, context) {
        const userContent = stripRecallBlocks(args.user_content);
        const assistantContent = stripRecallBlocks(args.assistant_content);
        if (!userContent || !assistantContent) {
          return unavailable(
            "capture",
            new Error(
              "capture content is empty after removing recalled context",
            ),
          );
        }
        try {
          const result = await service.run(() =>
            service.client.capture({
              user_content: userContent,
              assistant_content: assistantContent,
              session_key: runtime.resolveSession(
                context.sessionID,
                args.session_key,
              ),
              session_id: args.session_id?.trim() || context.sessionID,
              user_id: runtime.userId(args.user_id),
              messages: args.messages
                ? sanitizeMessages(args.messages)
                : [
                    { role: "user", content: userContent },
                    { role: "assistant", content: assistantContent },
                  ],
            }),
          );
          return runtime.formatter.capture(result);
        } catch (error) {
          return unavailable("capture", error);
        }
      },
    }),

    agent_memory_search: tool({
      description:
        "Search L1 structured memories for historical facts, preferences, or decisions.",
      args: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
        type: z.string().optional(),
        scene: z.string().optional(),
      },
      async execute(args) {
        try {
          const result = await service.run(() =>
            service.client.searchMemories({
              query: args.query.trim(),
              limit: limit(args.limit),
              type: args.type?.trim() || undefined,
              scene: args.scene?.trim() || undefined,
            }),
          );
          return runtime.formatter.memorySearch(result);
        } catch (error) {
          return unavailable("memory search", error);
        }
      },
    }),

    agent_conversation_search: tool({
      description:
        "Search L0 raw conversations when exact historical wording or evidence is needed.",
      args: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
        session_key: z.string().optional(),
      },
      async execute(args, context) {
        try {
          const result = await service.run(() =>
            service.client.searchConversations({
              query: args.query.trim(),
              limit: limit(args.limit),
              session_key: args.session_key
                ? runtime.resolveSession(context.sessionID, args.session_key)
                : undefined,
            }),
          );
          return runtime.formatter.conversationSearch(result);
        } catch (error) {
          return unavailable("conversation search", error);
        }
      },
    }),

    agent_memory_session_end: tool({
      description: "Flush pending memory extraction for an OpenCode session.",
      args: {
        session_key: z.string().optional(),
        user_id: z.string().optional(),
      },
      async execute(args, context) {
        try {
          const result = await service.run(() =>
            service.client.sessionEnd({
              session_key: runtime.resolveSession(
                context.sessionID,
                args.session_key,
              ),
              user_id: runtime.userId(args.user_id),
            }),
          );
          return runtime.formatter.sessionEnd(result);
        } catch (error) {
          return unavailable("session flush", error);
        }
      },
    }),

    agent_memory_seed: tool({
      description:
        "Import prepared historical conversations through the Agent Memory seed pipeline.",
      args: {
        data: z.any(),
        session_key: z.string().optional(),
        strict_round_role: z.boolean().optional(),
        auto_fill_timestamps: z.boolean().optional(),
        config_override: z.record(z.string(), z.any()).optional(),
      },
      async execute(args, context) {
        try {
          const result = await service.run(() =>
            service.client.seed({
              data: args.data,
              session_key: args.session_key
                ? runtime.resolveSession(context.sessionID, args.session_key)
                : undefined,
              strict_round_role: args.strict_round_role,
              auto_fill_timestamps: args.auto_fill_timestamps,
              config_override: args.config_override,
            }),
          );
          return runtime.formatter.seed(result);
        } catch (error) {
          return unavailable("seed import", error);
        }
      },
    }),
  };
}
