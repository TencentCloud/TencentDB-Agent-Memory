import type { CaptureTurn, SkillCaptureMessage } from "./client.js";

const RECALL_BEGIN = "BEGIN_TENCENTDB_RECALLED_MEMORY";
const RECALL_END = "END_TENCENTDB_RECALLED_MEMORY";
const TRUNCATED = "\n...[capture truncated]";

function truncate(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, Math.max(0, maxChars - TRUNCATED.length)).trimEnd() + TRUNCATED;
}

function redact(value: string): string {
  return value
    .replace(new RegExp(`${RECALL_BEGIN}[\\s\\S]*?${RECALL_END}`, "g"), "[recalled memory omitted]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(
      /(["']?\b(?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*)["']?([^"'\s,;}]+)["']?/gi,
      "$1\"[REDACTED]\"",
    )
    .trim();
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const item = part as { type?: unknown; text?: unknown };
      if (item.type === "text" && typeof item.text === "string") return item.text;
      if (item.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable arguments]";
  }
}

function clean(value: string, maxChars: number): string {
  return truncate(redact(value), maxChars);
}

export function buildCaptureTurn(
  sessionId: string,
  originalPrompt: string,
  messages: unknown[],
  maxChars: number,
  capturedAtMs = Date.now(),
): CaptureTurn | null {
  const skillMessages: SkillCaptureMessage[] = [
    {
      role: "user",
      content: clean(originalPrompt, maxChars),
      timestamp: capturedAtMs,
    },
  ];
  let finalAssistant = "";

  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as Record<string, unknown>;
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : capturedAtMs;

    if (message.role === "assistant" && Array.isArray(message.content)) {
      const assistantParts: string[] = [];
      const flushAssistant = (): void => {
        const assistant = clean(assistantParts.join("\n"), maxChars);
        assistantParts.length = 0;
        if (!assistant) return;
        skillMessages.push({ role: "assistant", content: assistant, timestamp });
        if (!["error", "aborted"].includes(String(message.stopReason))) finalAssistant = assistant;
      };
      for (const rawPart of message.content) {
        if (!rawPart || typeof rawPart !== "object") continue;
        const part = rawPart as Record<string, unknown>;
        if (part.type === "text" && typeof part.text === "string") assistantParts.push(part.text);
        if (part.type === "toolCall" && typeof part.id === "string") {
          flushAssistant();
          skillMessages.push({
            role: "tool_call",
            content: clean(safeJson(part.arguments ?? {}), maxChars),
            tool_name: typeof part.name === "string" ? part.name : undefined,
            tool_call_id: part.id,
            timestamp,
          });
        }
      }
      flushAssistant();
      continue;
    }

    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      skillMessages.push({
        role: "tool_result",
        content: clean(textContent(message.content), maxChars) || "[empty tool result]",
        tool_name: typeof message.toolName === "string" ? message.toolName : undefined,
        tool_call_id: message.toolCallId,
        timestamp,
      });
    }
  }

  if (!finalAssistant) return null;
  return {
    sessionId,
    user: clean(originalPrompt, maxChars),
    assistant: finalAssistant,
    skillMessages,
    capturedAtMs,
  };
}

export function hasCompletedAssistant(messages: unknown[]): boolean {
  return messages.some((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const message = raw as Record<string, unknown>;
    if (message.role !== "assistant" || ["error", "aborted"].includes(String(message.stopReason))) {
      return false;
    }
    return textContent(message.content).trim().length > 0;
  });
}
