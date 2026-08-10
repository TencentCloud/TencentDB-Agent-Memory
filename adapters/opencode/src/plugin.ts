import { tool, type Hooks, type PluginInput } from "@opencode-ai/plugin";

import { TdaiMemoryClient, turnKey, type MemoryClientLike } from "./client.js";
import { loadConfig, type OpenCodeMemoryConfig } from "./config.js";
import { formatRecall, latestCompletedTurn, textFromParts } from "./format.js";

type LogLevel = "debug" | "info" | "warn" | "error";
type Logger = (level: LogLevel, message: string, extra?: Record<string, unknown>) => Promise<void>;

interface HookDependencies {
  client: PluginInput["client"];
  directory: string;
  config: OpenCodeMemoryConfig;
  memory: MemoryClientLike;
  log: Logger;
}

function compactError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Math.max(1, Math.min(20, Math.trunc(value)));
}

export function createOpenCodeMemoryHooks({
  client,
  directory,
  config,
  memory,
  log,
}: HookDependencies): Hooks {
  const pendingQueries = new Map<string, string>();
  const capturedTurns = new Set<string>();

  async function captureSession(sessionId: string): Promise<void> {
    try {
      const response = await client.session.messages({
        path: { id: sessionId },
        query: { directory },
      });
      const turn = latestCompletedTurn(
        (response.data ?? []) as Array<{
          info: Record<string, unknown>;
          parts: Array<Record<string, unknown>>;
        }>,
      );
      if (!turn) return;
      const key = turnKey(turn);
      if (capturedTurns.has(key)) return;
      await memory.captureTurn(turn);
      capturedTurns.add(key);
      if (capturedTurns.size > 100) capturedTurns.delete(capturedTurns.values().next().value!);
    } catch (error) {
      await log("warn", "Failed to capture completed OpenCode turn", {
        error: compactError(error),
        sessionId,
      });
    }
  }

  return {
    "chat.message": async (input, output) => {
      if (!config.recallEnabled) return;
      const query = textFromParts(output.parts as Array<Record<string, unknown>>);
      if (query) pendingQueries.set(input.sessionID, query);
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!config.recallEnabled || !input.sessionID) return;
      const query = pendingQueries.get(input.sessionID);
      if (!query) return;
      pendingQueries.delete(input.sessionID);
      try {
        const recalled = await memory.recall(query);
        const context = formatRecall(recalled, config.maxContextChars);
        if (context) output.system.push(context);
        if (recalled.warnings.length > 0) {
          await log("warn", "TencentDB Agent Memory recall completed with warnings", {
            warnings: recalled.warnings,
          });
        }
      } catch (error) {
        await log("warn", "TencentDB Agent Memory recall failed; continuing without memory", {
          error: compactError(error),
          sessionId: input.sessionID,
        });
      }
    },

    event: async ({ event }) => {
      if (!config.captureEnabled || event.type !== "session.idle") return;
      await captureSession(event.properties.sessionID);
    },

    tool: {
      tdai_memory_search: tool({
        description: "Search long-term atomic memories in TencentDB Agent Memory",
        args: {
          query: tool.schema.string().min(1).describe("Memory search query"),
          limit: tool.schema.number().int().min(1).max(20).optional(),
        },
        async execute(args, context) {
          const items = await memory.searchAtomic(
            args.query,
            boundedLimit(args.limit, config.recallLimit),
            context.abort,
          );
          return JSON.stringify(items, null, 2);
        },
      }),
      tdai_conversation_search: tool({
        description: "Search previous conversation turns in TencentDB Agent Memory",
        args: {
          query: tool.schema.string().min(1).describe("Conversation search query"),
          limit: tool.schema.number().int().min(1).max(20).optional(),
          session_id: tool.schema.string().min(1).optional(),
        },
        async execute(args, context) {
          const items = await memory.searchConversation(
            args.query,
            boundedLimit(args.limit, config.recallLimit),
            args.session_id,
            context.abort,
          );
          return JSON.stringify(items, null, 2);
        },
      }),
      tdai_memory_status: tool({
        description: "Check TencentDB Agent Memory connectivity and atomic memory count",
        args: {},
        async execute(_args, context) {
          const total = await memory.check(context.abort);
          return `TencentDB Agent Memory is reachable. Atomic memories: ${total}.`;
        },
      }),
    },
  };
}

export async function createPlugin(input: PluginInput): Promise<Hooks> {
  const log: Logger = async (level, message, extra = {}) => {
    await input.client.app.log({
      body: { service: "tencentdb-agent-memory", level, message, extra },
    });
  };
  const result = loadConfig();
  if (!result.ok) {
    await log("error", "TencentDB Agent Memory plugin is disabled: invalid configuration", {
      errors: result.errors,
    });
    return {};
  }
  return createOpenCodeMemoryHooks({
    client: input.client,
    directory: input.directory,
    config: result.value,
    memory: new TdaiMemoryClient(result.value),
    log,
  });
}
