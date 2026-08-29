import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  boundConversationMessage,
  diagnosticText,
  TdaiMemoryClient,
  turnKey,
  type CaptureTurn,
  type MemoryClientLike,
} from "./client.js";
import { loadConfig, type PiMemoryConfig } from "./config.js";
import {
  extractFinalAssistant,
  formatAtomicResults,
  formatConversationResults,
  formatRecallContext,
  sanitizeAtomicMemory,
  sanitizeConversationMemory,
} from "./format.js";

export interface ExtensionDependencies {
  env?: Record<string, string | undefined>;
  clientFactory?: (config: PiMemoryConfig) => MemoryClientLike;
  logger?: Pick<Console, "warn">;
}

const CAPTURE_ENTRY_TYPE = "tdai-memory-captured";

function sessionId(ctx: ExtensionContext): string {
  return "pi:" + ctx.sessionManager.getSessionId();
}

function setStatus(ctx: ExtensionContext, value: string): void {
  if (!ctx.hasUI) return;
  try {
    ctx.ui.setStatus("tdai-memory", value);
  } catch {
    // UI teardown must not turn a best-effort memory update into a Pi failure.
  }
}

function notify(ctx: ExtensionContext, value: string, level: "info" | "warning" | "error"): void {
  if (!ctx.hasUI) return;
  try {
    ctx.ui.notify(value, level);
  } catch {
    // Notifications are diagnostic only and can race session replacement.
  }
}

export function createTencentDbMemoryExtension(dependencies: ExtensionDependencies = {}) {
  const env = dependencies.env ?? process.env;
  const logger = dependencies.logger ?? console;
  const clientFactory = dependencies.clientFactory ?? ((config: PiMemoryConfig) => new TdaiMemoryClient(config));

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
    const pending = new Map<string, CaptureTurn>();
    const captured = new Set<string>();
    const capturedOrder: string[] = [];
    const activePrompts: string[] = [];
    let settledMessages: unknown[] = [];
    let fallbackCaptureSequence = 0;
    let activeFallbackCaptureId: string | undefined;
    let flushing: Promise<void> | undefined;

    const rememberCaptured = (key: string): void => {
      if (captured.has(key)) return;
      captured.add(key);
      capturedOrder.push(key);
      if (capturedOrder.length > 512) {
        const oldest = capturedOrder.shift();
        if (oldest) captured.delete(oldest);
      }
    };

    const queueTurn = (turn: CaptureTurn): void => {
      const key = turnKey(turn);
      const normalized: CaptureTurn = {
        ...turn,
        user: boundConversationMessage(turn.user),
        assistant: boundConversationMessage(turn.assistant),
      };
      if (captured.has(key) || pending.has(key)) return;
      pending.set(key, normalized);
    };

    const flushPendingNow = async (ctx: ExtensionContext): Promise<void> => {
      for (const [key, turn] of pending) {
        if (captured.has(key)) {
          pending.delete(key);
          continue;
        }
        try {
          await client.captureTurn(turn, ctx.signal);
          rememberCaptured(key);
          pending.delete(key);
          try {
            pi.appendEntry(CAPTURE_ENTRY_TYPE, { key });
          } catch (error) {
            logger.warn("[tdai-memory] could not persist capture marker: " + diagnosticText(error));
          }
          setStatus(ctx, "memory: synced");
        } catch (error) {
          setStatus(ctx, "memory: offline");
          logger.warn("[tdai-memory] capture failed: " + diagnosticText(error));
          break;
        }
      }
    };

    const flushPending = (ctx: ExtensionContext): Promise<void> => {
      if (flushing) return flushing;
      flushing = flushPendingNow(ctx).finally(() => {
        flushing = undefined;
      });
      return flushing;
    };

    const stageCompletedTurn = (ctx: ExtensionContext): void => {
      if (activePrompts.length === 0) return;
      const assistant = extractFinalAssistant(settledMessages);
      if (assistant) {
        queueTurn({
          sessionId: sessionId(ctx),
          user: activePrompts.join("\n\n--- queued follow-up ---\n\n"),
          assistant: assistant.text,
          capturedAtMs: assistant.timestamp ?? Date.now(),
          captureId:
            assistant.timestamp === undefined
              ? activeFallbackCaptureId
              : "assistant:" + assistant.timestamp,
        });
      }
      activePrompts.length = 0;
      settledMessages = [];
      activeFallbackCaptureId = undefined;
    };

    pi.on("session_start", async (_event, ctx) => {
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type !== "custom" || entry.customType !== CAPTURE_ENTRY_TYPE) continue;
        const data = entry.data;
        if (data && typeof data === "object" && typeof (data as { key?: unknown }).key === "string") {
          rememberCaptured((data as { key: string }).key);
        }
      }
      setStatus(ctx, "memory: on");
    });

    pi.on("before_agent_start", async (event, ctx) => {
      if (event.prompt.trim()) {
        if (activePrompts.length === 0) {
          fallbackCaptureSequence += 1;
          activeFallbackCaptureId = "run:" + fallbackCaptureSequence;
        }
        activePrompts.push(event.prompt);
      }
      if (!event.prompt.trim()) return;
      try {
        const recalled = await client.recall(event.prompt, ctx.signal);
        const context = formatRecallContext(recalled, config.maxContextChars);
        setStatus(ctx, recalled.warnings.length > 0 ? "memory: partial" : "memory: recalled");
        if (!context) return;
        return { systemPrompt: event.systemPrompt + "\n\n" + context };
      } catch (error) {
        setStatus(ctx, "memory: offline");
        logger.warn("[tdai-memory] recall failed: " + diagnosticText(error));
        return;
      }
    });

    pi.on("agent_end", async (event) => {
      if (activePrompts.length === 0 || !Array.isArray(event.messages)) return;
      settledMessages.push(...event.messages);
    });

    pi.on("agent_settled", async (_event, ctx) => {
      stageCompletedTurn(ctx);
      await flushPending(ctx);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      stageCompletedTurn(ctx);
      await flushPending(ctx);
    });

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
          query: Type.String({
            minLength: 1,
            maxLength: 2_048,
            description: "Semantic memory search query",
          }),
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
            details: { count: items.length, items: items.map(sanitizeAtomicMemory) },
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: "Memory search failed: " + diagnosticText(error) }],
            details: { count: 0, items: [] as Awaited<ReturnType<typeof client.searchAtomic>> },
            isError: true,
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
          query: Type.String({
            minLength: 1,
            maxLength: 2_048,
            description: "Conversation search query",
          }),
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
            details: { count: items.length, items: items.map(sanitizeConversationMemory) },
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: "Conversation search failed: " + diagnosticText(error) }],
            details: {
              count: 0,
              items: [] as Awaited<ReturnType<typeof client.searchConversation>>,
            },
            isError: true,
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
          notify(ctx, "TencentDB memory check failed: " + diagnosticText(error), "error");
        }
      },
    });
  };
}
