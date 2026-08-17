import type { ConversationItem } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import { redactText, truncateUtf8 } from "./security.js";

interface TextBlock {
  type: "text";
  text: string;
}

interface ToolResultLike {
  toolName: string;
  isError: boolean;
  content: unknown;
}

const MAX_TOOL_ITEMS = 8;
const MAX_TOOL_ITEM_BYTES = 2048;

function safeToolName(value: string): string {
  const cleaned = value.replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return cleaned || "unknown";
}

function toolText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.filter(isTextBlock).map((part) => part.text).join("\n").trim();
}

interface AssistantLike {
  role: "assistant";
  content: unknown;
  stopReason?: string;
}

/**
 * Shape guard for the Pi `AssistantMessage` contract this adapter reads.
 *
 * The adapter intentionally depends only on the parts of Pi's message format
 * that its capture path needs: an assistant message carries a `stopReason` and
 * a content array of typed blocks, of which `{ type: "text", text }` is the
 * only kind worth persisting. If Pi ever changes that shape (renames the role,
 * replaces the content array with a string, moves text under a different
 * block type), this guard makes the adapter fail CLOSED — no capture — instead
 * of silently mis-parsing a changed format.
 */
function isAssistant(value: unknown): value is AssistantLike {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { role?: unknown; content?: unknown };
  return candidate.role === "assistant" && Array.isArray(candidate.content);
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

export function createConversationMessages(
  prompt: string,
  assistant: string,
  toolResults: readonly ToolResultLike[] = [],
): ConversationItem[] {
  const messages: ConversationItem[] = [
    { role: "user", content: truncateUtf8(redactText(prompt.trim()), 8192) },
    { role: "assistant", content: truncateUtf8(redactText(assistant.trim()), 8192) },
  ];
  const evidence = toolResults
    .filter((result) => !result.isError)
    .slice(0, MAX_TOOL_ITEMS)
    .map((result) => {
      const text = toolText(result.content);
      if (!text) return undefined;
      return `[tool:${safeToolName(result.toolName)}]\n${truncateUtf8(redactText(text), MAX_TOOL_ITEM_BYTES)}`;
    })
    .filter((value): value is string => Boolean(value));
  if (evidence.length > 0) messages.push({ role: "system", content: evidence.join("\n\n") });
  return messages;
}
