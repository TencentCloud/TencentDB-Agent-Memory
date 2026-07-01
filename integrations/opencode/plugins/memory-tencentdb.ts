import { createHash } from "node:crypto";
import type { GatewayClientOptions } from "../../../src/integrations/shared/gateway-client.js";
import { captureMemory, endSession, recallMemory } from "../tools/memory-tencentdb.js";

export interface OpenCodeMemoryEvent {
  session_id?: string;
  sessionId?: string;
  thread_id?: string;
  threadId?: string;
  user_id?: string;
  userId?: string;
  cwd?: string;
  prompt?: string;
  input?: string;
  message?: string;
  assistant_text?: string;
  assistantText?: string;
  output?: string;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function cwdSessionKey(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const digest = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  return `opencode:cwd:${digest}`;
}

export function resolveOpenCodeMemoryContext(event: OpenCodeMemoryEvent = {}) {
  const sessionKey = firstString(
    event.session_id,
    event.sessionId,
    event.thread_id,
    event.threadId,
    cwdSessionKey(event.cwd),
  ) ?? "opencode:default";
  const sessionId = firstString(event.session_id, event.sessionId, event.thread_id, event.threadId);
  const userId = firstString(event.user_id, event.userId);

  return { sessionKey, sessionId, userId };
}

export function createMemoryTencentDbPlugin(gateway: GatewayClientOptions = {}) {
  const promptCache = new Map<string, string>();

  return {
    name: "memory-tencentdb",

    async onUserPrompt(event: OpenCodeMemoryEvent) {
      const prompt = firstString(event.prompt, event.input, event.message);
      if (!prompt) return undefined;
      const ctx = resolveOpenCodeMemoryContext(event);
      promptCache.set(ctx.sessionKey, prompt);
      return recallMemory({
        query: prompt,
        session_key: ctx.sessionKey,
        user_id: ctx.userId,
      }, gateway);
    },

    async onAssistantMessage(event: OpenCodeMemoryEvent) {
      const ctx = resolveOpenCodeMemoryContext(event);
      const prompt = promptCache.get(ctx.sessionKey);
      const assistantText = firstString(event.assistant_text, event.assistantText, event.output, event.message);
      if (!prompt || !assistantText) return undefined;
      return captureMemory({
        user_content: prompt,
        assistant_content: assistantText,
        session_key: ctx.sessionKey,
        session_id: ctx.sessionId,
        user_id: ctx.userId,
      }, gateway);
    },

    async onSessionEnd(event: OpenCodeMemoryEvent) {
      const ctx = resolveOpenCodeMemoryContext(event);
      promptCache.delete(ctx.sessionKey);
      return endSession({
        session_key: ctx.sessionKey,
        user_id: ctx.userId,
      }, gateway);
    },
  };
}

