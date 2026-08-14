/**
 * Pi extension wiring for the TencentDB Agent Memory adapter.
 *
 * Automatic recall runs before each agent turn and injects bounded, untrusted
 * memory into the system prompt. Once a turn fully settles, the completed
 * user/assistant exchange is captured to L0 and the ordered tool trace is sent
 * to the Skill pipeline. Every memory operation fails open: a MemoryCore outage
 * degrades to warnings and never blocks the main Pi conversation.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { buildCaptureTurn, hasCompletedAssistant } from "./capture.js";
import {
  TdaiMemoryClient,
  type CaptureTurn,
  type MemoryClientLike,
} from "./client.js";
import { loadConfig, type PiMemoryConfig } from "./config.js";
import {
  formatAtomicResults,
  formatConversationResults,
  formatRecallContext,
  formatScenarioContext,
} from "./format.js";

export interface ExtensionDependencies {
  env?: Record<string, string | undefined>;
  clientFactory?: (config: PiMemoryConfig) => MemoryClientLike;
  logger?: Pick<Console, "warn">;
}

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

export function createTencentDbMemoryExtension(dependencies: ExtensionDependencies = {}) {
  const env = dependencies.env ?? process.env;
  const logger = dependencies.logger ?? console;
  const clientFactory =
    dependencies.clientFactory ?? ((config: PiMemoryConfig) => new TdaiMemoryClient(config));

  return function tencentDbMemory(pi: ExtensionAPI): void {
    const loaded = loadConfig(env);
    if (!loaded.ok) {
      pi.registerCommand("tdai-memory-status", {
        description: "Show TencentDB Agent Memory adapter status",
        handler: async (_args, ctx) => {
          notify(ctx, "TencentDB memory is disabled: " + loaded.errors.join("; "), "warning");
        },
      });
      return;
    }

    const config = loaded.value;
    const client = clientFactory(config);
    let activePrompts: string[] = [];
    let settledMessages: unknown[] = [];

    pi.on("before_agent_start", async (event, ctx) => {
      const prompt = event.prompt.trim();
      if (prompt) activePrompts.push(prompt);
      if (!prompt) return;
      try {
        const recalled = await client.recall(prompt, ctx.signal);
        setStatus(ctx, recalled.warnings.length > 0 ? "memory: partial" : "memory: recalled");
        const context = formatRecallContext(recalled, config.maxContextChars);
        if (!context) return;
        return { systemPrompt: event.systemPrompt + "\n\n" + context };
      } catch (error) {
        setStatus(ctx, "memory: offline");
        logger.warn("[tdai-memory] recall failed: " + messageOf(error));
        return;
      }
    });

    pi.on("agent_end", async (event) => {
      if (activePrompts.length === 0 || !hasCompletedAssistant(event.messages)) return;
      settledMessages.push(...event.messages);
    });

    pi.on("agent_settled", async (_event, ctx) => {
      if (activePrompts.length === 0) return;
      const turn = buildCaptureTurn(
        sessionId(ctx),
        activePrompts.join("\n\n--- queued follow-up ---\n\n"),
        settledMessages,
        config.maxCaptureChars,
      );
      activePrompts.length = 0;
      settledMessages = [];
      if (!turn) return;
      await flushCapture(turn, ctx);
    });

    pi.on("session_shutdown", async () => {
      activePrompts.length = 0;
      settledMessages = [];
    });

    async function flushCapture(turn: CaptureTurn, ctx: ExtensionContext): Promise<void> {
      try {
        await client.captureConversation(turn, ctx.signal);
        setStatus(ctx, "memory: synced");
      } catch (error) {
        setStatus(ctx, "memory: partial");
        logger.warn("[tdai-memory] L0 capture failed: " + messageOf(error));
      }
      try {
        await client.captureSkill(turn, ctx.signal);
      } catch (error) {
        logger.warn("[tdai-memory] Skill capture failed: " + messageOf(error));
      }
    }

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
          const items = await client.searchAtomic(params.query, params.limit ?? config.recallLimit, signal);
          return {
            content: [{ type: "text", text: formatAtomicResults(items, config.maxContextChars) }],
            details: { count: items.length },
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: "Memory search failed: " + messageOf(error) }],
            details: { count: 0 },
          };
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
            content: [{ type: "text", text: formatConversationResults(items, config.maxContextChars) }],
            details: { count: items.length },
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: "Conversation search failed: " + messageOf(error) }],
            details: { count: 0 },
          };
        }
      },
    });

    pi.registerTool({
      name: "tdai_memory_recall",
      label: "Recall TencentDB memory context",
      description:
        "Read the scenario index (L2) and core profile (L3) to recover the current team/agent working context.",
      promptSnippet: "Read scenario index and core profile to recover context",
      promptGuidelines: [
        "Use tdai_memory_recall to explicitly review the current agent's scenario index and core profile.",
      ],
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_toolCallId, _params, signal) {
        try {
          const [scenarios, core] = await Promise.allSettled([
            client.listScenarios(signal),
            client.readCore(signal),
          ]);
          const scenarioList = scenarios.status === "fulfilled" ? scenarios.value : [];
          const coreText = core.status === "fulfilled" ? core.value : null;
          const context = formatScenarioContext(scenarioList, coreText, config.maxContextChars);
          if (!context) {
            return {
              content: [{ type: "text", text: "No scenarios or core profile found." }],
              details: { scenarioCount: 0 },
            };
          }
          return {
            content: [{ type: "text", text: context }],
            details: { scenarioCount: scenarioList.length },
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: "Memory recall failed: " + messageOf(error) }],
            details: { scenarioCount: 0 },
          };
        }
      },
    });

    pi.registerCommand("tdai-memory-status", {
      description: "Check TencentDB Agent Memory connectivity",
      handler: async (_args, ctx) => {
        try {
          const count = await client.check(ctx.signal);
          setStatus(ctx, "memory: online");
          notify(ctx, "TencentDB memory is online (" + count + " atomic memories).", "info");
        } catch (error) {
          setStatus(ctx, "memory: offline");
          notify(ctx, "TencentDB memory check failed: " + messageOf(error), "error");
        }
      },
    });
  };
}
