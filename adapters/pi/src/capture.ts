import type { ConversationItem } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import { redactText, truncateUtf8 } from "./security.js";

interface TextBlock {
  type: "text";
  text: string;
}

interface AssistantLike {
  role: "assistant";
  content: unknown;
  stopReason?: string;
}

function isAssistant(value: unknown): value is AssistantLike {
  return Boolean(value && typeof value === "object" && (value as { role?: unknown }).role === "assistant");
}

function isTextBlock(value: unknown): value is TextBlock {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { type?: unknown }).type === "text" &&
      typeof (value as { text?: unknown }).text === "string",
  );
}

export function lastSuccessfulAssistantText(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isAssistant(message)) continue;
    if (message.stopReason !== "stop") continue;
    if (!Array.isArray(message.content)) continue;
    const text = message.content.filter(isTextBlock).map((part) => part.text).join("\n").trim();
    if (text) return text;
  }
  return undefined;
}

export function createConversationMessages(prompt: string, assistant: string): ConversationItem[] {
  return [
    { role: "user", content: truncateUtf8(redactText(prompt.trim()), 8192) },
    { role: "assistant", content: truncateUtf8(redactText(assistant.trim()), 8192) },
  ];
}
