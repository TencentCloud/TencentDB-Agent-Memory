import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createConversationMessages, lastSuccessfulAssistantText } from "./capture.js";
import { createClients, createSessionMemoryClient } from "./clients.js";
import { loadConfig } from "./config.js";
import { enqueueCapture, flushOutbox } from "./outbox.js";
import { injectRecall, recallMemory } from "./recall.js";
import { BRANCH_ENTRY_TYPE, createBranchId, memorySessionId, restoreBranchId } from "./session.js";
import { runSetup } from "./setup.js";
import { checkStatus, formatStatus } from "./status.js";
import {
  conversationSearch,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_QUERY_CHARS,
  MAX_SESSION_KEY_CHARS,
  memorySearch,
  memorySearchMessage,
} from "./tools.js";
import type { ConfigResult } from "./types.js";

const STATUS_KEY = "tdai-memory";
const MEMORY_SEARCH_TOOLS = new Set(["tdai_memory_search", "tdai_conversation_search"]);

type TimedOutcome<T> = { ok: true; value: T } | { ok: false };

async function settleWithin<T>(work: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const guarded = work.then<TimedOutcome<T>, TimedOutcome<T>>(
    (value) => ({ ok: true, value }),
    () => ({ ok: false }),
  );
  const outcome = await Promise.race([
    guarded,
    new Promise<TimedOutcome<T>>((resolve) => {
      timeoutHandle = setTimeout(() => resolve({ ok: false }), timeoutMs);
    }),
  ]);
  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  return outcome.ok ? outcome.value : undefined;
}

export default function tdaiMemoryExtension(pi: ExtensionAPI): void {
  let currentConfig: ConfigResult | undefined;
  let activePrompt: string | undefined;
  let finalAssistant: string | undefined;
  let successfulToolResults: Array<{ toolName: string; isError: boolean; content: unknown }> = [];
  let activeBranchId = "root";
  let memoryToolCallsThisTurn = 0;

  const memoryUnavailable = () => memorySearchMessage("Memory not configured. Continue without memory.");
  const memorySearchTimedOut = () => memorySearchMessage("Memory search unavailable. Continue without memory.");
  const memoryToolLimitReached = () =>
    memorySearchMessage("Memory search limit reached for this turn. Use existing information to answer.");

  pi.registerTool({
    name: "tdai_memory_search",
    label: "Search memory",
    description: "Search structured memories (L1): user preferences, past events, rules, facts.",
    promptSnippet: "Search L1 memories when needed; use both memory search tools at most 3 times total per turn, then answer from existing information.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: MAX_SEARCH_QUERY_CHARS }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_LIMIT })),
      type: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      if (!currentConfig?.ok || !currentConfig.config.enabled) return memoryUnavailable();
      if (memoryToolCallsThisTurn >= 3) return memoryToolLimitReached();
      memoryToolCallsThisTurn += 1;
      return (
        (await settleWithin(
          memorySearch(createClients(currentConfig.config).memory, params),
          currentConfig.config.recall.deadlineMs,
        )) ?? memorySearchTimedOut()
      );
    },
  });

  pi.registerTool({
    name: "tdai_conversation_search",
    label: "Search conversation history",
    description: "Search raw conversation history (L0) with timestamps.",
    promptSnippet: "Search L0 conversations when needed; use both memory search tools at most 3 times total per turn, then answer from existing information.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: MAX_SEARCH_QUERY_CHARS }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_LIMIT })),
      session_key: Type.Optional(Type.String({ maxLength: MAX_SESSION_KEY_CHARS })),
    }),
    execute: async (_toolCallId, params) => {
      if (!currentConfig?.ok || !currentConfig.config.enabled) return memoryUnavailable();
      if (memoryToolCallsThisTurn >= 3) return memoryToolLimitReached();
      memoryToolCallsThisTurn += 1;
      return (
        (await settleWithin(
          conversationSearch(createClients(currentConfig.config).memory, params),
          currentConfig.config.recall.deadlineMs,
        )) ?? memorySearchTimedOut()
      );
    },
  });

  pi.registerCommand("tdai-memory-setup", {
    description: "Interactively configure TencentDB Agent Memory for Pi",
    handler: async (_args, ctx) => {
      const setup = await runSetup(ctx);
      if (!setup.ok) {
        ctx.ui.setStatus(STATUS_KEY, "memory: setup incomplete");
        ctx.ui.notify(setup.message, setup.cancelled ? "warning" : "error");
        return;
      }

      currentConfig = await loadConfig({
        cwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
      });
      if (!currentConfig.ok || !currentConfig.config.enabled) {
        ctx.ui.setStatus(STATUS_KEY, "memory: setup needs attention");
        const details = !currentConfig.ok ? currentConfig.errors.join("; ") : "adapter is disabled";
        ctx.ui.notify(`Memory setup saved, but configuration could not be activated: ${details}`, "error");
        return;
      }

      ctx.ui.setStatus(STATUS_KEY, "memory: configured");
      await ctx.reload();
      ctx.ui.notify(
        setup.createdAgent
          ? "Memory setup complete. A private Pi Agent was created and the extension was reloaded."
          : "Memory setup complete. The extension was reloaded.",
        "info",
      );
    },
  });

  pi.registerCommand("tdai-memory-status", {
    description: "Check TencentDB Agent Memory configuration, identity, and connectivity",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus(STATUS_KEY, "memory: checking config");
      const config =
        currentConfig ??
        (await loadConfig({
          cwd: ctx.cwd,
          projectTrusted: ctx.isProjectTrusted(),
        }));
      ctx.ui.setStatus(STATUS_KEY, "memory: checking connection");
      const status = await checkStatus(config, (phase) => {
        ctx.ui.setStatus(STATUS_KEY, `memory: checking ${phase}`);
      });
      ctx.ui.setStatus(STATUS_KEY, status.summary);
      const kind = status.kind === "ready" || status.kind === "disabled" ? "info" : status.kind === "offline" ? "warning" : "error";
      ctx.ui.notify(formatStatus(status), kind);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    activeBranchId = restoreBranchId(ctx.sessionManager.getBranch()) ?? "root";
    currentConfig = await loadConfig({
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
    });
    if (!currentConfig.ok) {
      ctx.ui.setStatus(STATUS_KEY, "memory: not configured");
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, currentConfig.config.enabled ? "memory: configured" : "memory: disabled");
    const loadedConfig = currentConfig.config;
    if (loadedConfig.enabled) {
      void flushOutbox(loadedConfig, async (record) => {
        const memory = createSessionMemoryClient(loadedConfig, record.sessionId);
        await memory.addConversation({ messages: record.messages });
      }).then((result) => {
        if (result.delivered > 0) ctx.ui.setStatus(STATUS_KEY, "memory: captured");
      }).catch(() => undefined);
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    const restored = restoreBranchId(ctx.sessionManager.getBranch());
    if (restored) {
      activeBranchId = restored;
      return;
    }
    activeBranchId = createBranchId();
    pi.appendEntry(BRANCH_ENTRY_TYPE, { branchId: activeBranchId, createdAt: new Date().toISOString() });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    memoryToolCallsThisTurn = 0;
    activePrompt = event.prompt;
    finalAssistant = undefined;
    successfulToolResults = [];
    if (!currentConfig?.ok || !currentConfig.config.enabled) return;
    try {
      const recalled = await settleWithin(
        recallMemory(
          createClients(currentConfig.config).memory,
          event.prompt,
          currentConfig.config.recall,
        ),
        currentConfig.config.recall.deadlineMs,
      );
      if (!recalled?.content) {
        if (!recalled) {
          ctx.ui.setStatus(STATUS_KEY, "memory: recall unavailable");
          return;
        }
        if (recalled.failedLayers.length > 0 || recalled.timedOutLayers.length > 0) {
          ctx.ui.setStatus(STATUS_KEY, "memory: recall unavailable");
        }
        return;
      }
      ctx.ui.setStatus(
        STATUS_KEY,
        recalled.failedLayers.length > 0 || recalled.timedOutLayers.length > 0
          ? "memory: recalled (partial)"
          : "memory: recalled",
      );
      return { systemPrompt: injectRecall(event.systemPrompt, recalled.content) };
    } catch {
      ctx.ui.setStatus(STATUS_KEY, "memory: recall unavailable");
      return;
    }
  });

  pi.on("agent_end", async (event) => {
    // A later failed/cancelled run must clear a prior successful answer: only
    // the final settled run is eligible for persistence.
    finalAssistant = lastSuccessfulAssistantText(event.messages);
  });

  pi.on("tool_result", async (event) => {
    if (
      !currentConfig?.ok ||
      !currentConfig.config.enabled ||
      !currentConfig.config.captureTools ||
      event.isError ||
      MEMORY_SEARCH_TOOLS.has(event.toolName)
    ) {
      return;
    }
    successfulToolResults.push({ toolName: event.toolName, isError: event.isError, content: event.content });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const prompt = activePrompt;
    const assistant = finalAssistant;
    const toolResults = successfulToolResults;
    activePrompt = undefined;
    finalAssistant = undefined;
    successfulToolResults = [];
    if (!prompt || !assistant || !currentConfig?.ok || !currentConfig.config.enabled) return;
    try {
      const sessionId = memorySessionId(ctx.sessionManager.getSessionId(), activeBranchId);
      const loadedConfig = currentConfig.config;
      const record = await enqueueCapture(loadedConfig, sessionId, createConversationMessages(prompt, assistant, toolResults));
      pi.appendEntry("tdai-memory/capture-queued@1", {
        sessionId,
        captureId: record.id,
        capturedAt: new Date().toISOString(),
      });
      ctx.ui.setStatus(STATUS_KEY, "memory: capture queued");
      void flushOutbox(loadedConfig, async (queued) => {
        const memory = createSessionMemoryClient(loadedConfig, queued.sessionId);
        await memory.addConversation({ messages: queued.messages });
      }).then((result) => {
        if (result.delivered > 0) ctx.ui.setStatus(STATUS_KEY, "memory: captured");
      }).catch(() => undefined);
    } catch {
      ctx.ui.setStatus(STATUS_KEY, "memory: capture failed");
    }
  });
}
