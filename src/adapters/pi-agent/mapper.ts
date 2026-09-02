import type { PiAgentExtensionContext, PiAgentMessage, PiAgentSessionEntry, PiAgentSessionEvent } from "./types.js";

export function getPiSessionId(event: PiAgentSessionEvent, ctx?: PiAgentExtensionContext): string | undefined {
  return event.sessionId
    ?? event.session_id
    ?? event.sessionFile
    ?? ctx?.sessionManager?.getSessionFile?.();
}

export function getPiWorkspace(event: PiAgentSessionEvent, ctx?: PiAgentExtensionContext): string | undefined {
  return event.workspace
    ?? event.cwd
    ?? event.systemPromptOptions?.cwd
    ?? ctx?.cwd;
}

export function getPiUserId(event: PiAgentSessionEvent): string | undefined {
  return event.userId ?? event.user_id;
}

export function getPiQuery(event: PiAgentSessionEvent): string | undefined {
  const value = event.prompt ?? event.query;
  return typeof value === "string" ? value : undefined;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block || typeof block !== "object") return "";
        const typed = block as { type?: unknown; text?: unknown; content?: unknown; thinking?: unknown };
        if (typeof typed.text === "string") return typed.text;
        if (typeof typed.content === "string") return typed.content;
        if (typeof typed.thinking === "string") return typed.thinking;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function messagesFromEntries(entries: PiAgentSessionEntry[] | undefined): PiAgentMessage[] {
  if (!entries) return [];
  return entries
    .filter((entry) => entry.type === "message" && entry.message)
    .map((entry) => entry.message!)
    .filter((message) => message.role === "user" || message.role === "assistant");
}

export function normalizePiMessages(event: PiAgentSessionEvent, ctx?: PiAgentExtensionContext): PiAgentMessage[] {
  const raw = event.messages ?? event.conversation ?? messagesFromEntries(event.entries ?? ctx?.sessionManager?.getEntries?.());
  return raw
    .map((message) => ({
      ...message,
      content: contentToText(message.content),
    }))
    .filter((message) => (message.role === "user" || message.role === "assistant") && typeof message.content === "string" && message.content.trim().length > 0);
}

export function piMessagesToSeedConversations(messages: PiAgentMessage[]) {
  const conversations: Array<{ user: string; assistant: string; timestamp?: string | number }> = [];
  let pendingUser: PiAgentMessage | undefined;

  for (const message of messages) {
    if (message.role === "user") {
      pendingUser = message;
      continue;
    }
    if (message.role === "assistant" && pendingUser) {
      conversations.push({
        user: String(pendingUser.content),
        assistant: String(message.content),
        timestamp: message.timestamp ?? pendingUser.timestamp,
      });
      pendingUser = undefined;
    }
  }

  return conversations;
}