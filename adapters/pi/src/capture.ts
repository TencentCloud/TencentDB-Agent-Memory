import type { CaptureTurn, SkillCaptureMessage } from "./client.js";
import { redact, safeJson } from "./redact.js";

const TRUNCATED = "\n...[capture truncated]";
const TRACE_TRUNCATED = "[skill trace truncated]";
const MAX_SKILL_MESSAGES = 500;
const MAX_L0_CHARS = 8_192;

function truncate(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, Math.max(0, maxChars - TRUNCATED.length)).trimEnd() + TRUNCATED;
}

function clean(value: string, maxChars: number): string {
  return truncate(redact(value), maxChars);
}

export function textContent(content: unknown): string {
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

function messageBytes(message: SkillCaptureMessage): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}

function boundSkillMessages(messages: SkillCaptureMessage[], maxBytes: number): SkillCaptureMessage[] {
  if (messages.length === 0) return [];
  const last = messages.at(-1);
  if (!last) return [];
  const selected: SkillCaptureMessage[] = [];
  let bytes = 2;
  const reserve = messageBytes(last) + messageBytes({ role: "assistant", content: TRACE_TRUNCATED }) + 2;

  for (const message of messages.slice(0, -1)) {
    if (selected.length >= MAX_SKILL_MESSAGES - 2) break;
    const size = messageBytes(message) + 1;
    if (bytes + size + reserve > maxBytes) break;
    selected.push(message);
    bytes += size;
  }

  const truncated = selected.length < messages.length - 1;
  if (truncated) selected.push({ role: "assistant", content: TRACE_TRUNCATED });
  selected.push(last);

  const calls = new Set(
    selected.filter((m) => m.role === "tool_call").map((m) => m.tool_call_id),
  );
  const results = new Set(
    selected.filter((m) => m.role === "tool_result").map((m) => m.tool_call_id),
  );
  return selected.filter(
    (message) =>
      !["tool_call", "tool_result"].includes(message.role) ||
      (calls.has(message.tool_call_id) && results.has(message.tool_call_id)),
  );
}

export function buildCaptureTurn(
  sessionId: string,
  originalPrompt: string,
  messages: unknown[],
  maxChars: number,
  capturedAtMs = Date.now(),
  maxSkillBytes = 512_000,
  clientMessageId?: string,
): CaptureTurn | null {
  return (
    buildCaptureTurnsInternal(
      sessionId,
      originalPrompt,
      messages,
      maxChars,
      capturedAtMs,
      maxSkillBytes,
      () => clientMessageId,
      false,
    ).at(-1) ?? null
  );
}

export function buildCaptureTurns(
  sessionId: string,
  originalPrompt: string,
  messages: unknown[],
  maxChars: number,
  capturedAtMs = Date.now(),
  maxSkillBytes = 512_000,
  nextClientMessageId: () => string | undefined = () => undefined,
): CaptureTurn[] {
  return buildCaptureTurnsInternal(
    sessionId,
    originalPrompt,
    messages,
    maxChars,
    capturedAtMs,
    maxSkillBytes,
    nextClientMessageId,
    true,
  );
}

function buildCaptureTurnsInternal(
  sessionId: string,
  originalPrompt: string,
  messages: unknown[],
  maxChars: number,
  capturedAtMs: number,
  maxSkillBytes: number,
  nextClientMessageId: () => string | undefined,
  splitOnUser: boolean,
): CaptureTurn[] {
  const skillChars = Math.min(maxChars, Math.max(500, Math.floor(maxSkillBytes / 4)));
  const turns: CaptureTurn[] = [];
  let skillMessages: SkillCaptureMessage[] = [];
  let finalAssistant = "";
  let users: string[] = [];

  const emitTurn = (): void => {
    if (!finalAssistant) return;
    if (users.length === 0) {
      const fallback = clean(originalPrompt, skillChars);
      if (fallback) {
        users.push(fallback);
        skillMessages.unshift({ role: "user", content: fallback, timestamp: capturedAtMs });
      }
    }
    if (users.length === 0) return;
    turns.push({
      sessionId,
      user: clean(users.join("\n\n--- queued follow-up ---\n\n"), Math.min(maxChars, MAX_L0_CHARS)),
      assistant: clean(finalAssistant, Math.min(maxChars, MAX_L0_CHARS)),
      skillMessages: boundSkillMessages(skillMessages, maxSkillBytes),
      capturedAtMs,
      clientMessageId: nextClientMessageId(),
    });
    skillMessages = [];
    finalAssistant = "";
    users = [];
  };

  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as Record<string, unknown>;
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : capturedAtMs;

    if (message.role === "user") {
      if (splitOnUser) emitTurn();
      const user = clean(textContent(message.content), skillChars);
      if (user) {
        users.push(user);
        skillMessages.push({ role: "user", content: user, timestamp });
      }
      continue;
    }

    // H1 fix: accept both string and array assistant content so a plain-text final
    // answer is never silently dropped (previously only Array.isArray content was
    // captured, while hasCompletedAssistant still flagged the turn for capture).
    if (message.role === "assistant") {
      const assistantParts: string[] = [];
      const flushAssistant = (): void => {
        const assistant = clean(assistantParts.join("\n"), skillChars);
        assistantParts.length = 0;
        if (!assistant) return;
        skillMessages.push({ role: "assistant", content: assistant, timestamp });
        if (!["error", "aborted"].includes(String(message.stopReason))) finalAssistant = assistant;
      };
      if (typeof message.content === "string") {
        assistantParts.push(message.content);
      } else if (Array.isArray(message.content)) {
        for (const rawPart of message.content) {
          if (!rawPart || typeof rawPart !== "object") continue;
          const part = rawPart as Record<string, unknown>;
          if (part.type === "text" && typeof part.text === "string") assistantParts.push(part.text);
          if (part.type === "toolCall" && typeof part.id === "string") {
            flushAssistant();
            skillMessages.push({
              role: "tool_call",
              content: clean(safeJson(part.arguments ?? {}), skillChars),
              tool_name: typeof part.name === "string" ? part.name : undefined,
              tool_call_id: part.id,
              timestamp,
            });
          }
        }
      }
      flushAssistant();
      continue;
    }

    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      skillMessages.push({
        role: "tool_result",
        content: clean(textContent(message.content), skillChars) || "[empty tool result]",
        tool_name: typeof message.toolName === "string" ? message.toolName : undefined,
        tool_call_id: message.toolCallId,
        timestamp,
      });
    }
  }

  emitTurn();
  return turns;
}

export function hasCompletedAssistant(messages: unknown[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const raw = messages[index];
    if (!raw || typeof raw !== "object") continue;
    const message = raw as Record<string, unknown>;
    if (message.role !== "assistant" || ["error", "aborted"].includes(String(message.stopReason))) {
      if (message.role === "assistant") return false;
      continue;
    }
    return textContent(message.content).trim().length > 0;
  }
  return false;
}
