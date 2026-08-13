import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createConversationMessages, lastSuccessfulAssistantText } from "./capture.js";
import { createClients, createSessionMemoryClient } from "./clients.js";
import { loadConfig } from "./config.js";
import { enqueueCapture, flushOutbox } from "./outbox.js";
import { injectRecall, recallMemory } from "./recall.js";
import { checkStatus, formatStatus } from "./status.js";
import type { ConfigResult } from "./types.js";

const STATUS_KEY = "tdai-memory";

export default function tdaiMemoryExtension(pi: ExtensionAPI): void {
  let currentConfig: ConfigResult | undefined;
  let activePrompt: string | undefined;
  let finalAssistant: string | undefined;
  let successfulToolResults: Array<{ toolName: string; isError: boolean; content: unknown }> = [];

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

  pi.on("before_agent_start", async (event, ctx) => {
    activePrompt = event.prompt;
    finalAssistant = undefined;
    successfulToolResults = [];
    if (!currentConfig?.ok || !currentConfig.config.enabled) return;
    try {
      const recalled = await recallMemory(
        createClients(currentConfig.config).memory,
        event.prompt,
        currentConfig.config.recall,
      );
      if (!recalled.content) {
        if (recalled.failedLayers.length > 0) ctx.ui.setStatus(STATUS_KEY, "memory: recall unavailable");
        return;
      }
      ctx.ui.setStatus(STATUS_KEY, recalled.failedLayers.length > 0 ? "memory: recalled (partial)" : "memory: recalled");
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
    if (!currentConfig?.ok || !currentConfig.config.enabled || !currentConfig.config.captureTools || event.isError) return;
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
      const sessionId = `pi-${ctx.sessionManager.getSessionId()}`;
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
