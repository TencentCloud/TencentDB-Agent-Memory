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

function skillMessagesBytes(messages: SkillCaptureMessage[]): number {
  return Buffer.byteLength(JSON.stringify(messages), "utf8");
}

function contentWithTrace(points: string[], length: number): string {
  return points.slice(0, length).join("").trimEnd() + "\n" + TRACE_TRUNCATED;
}

function compactToolMetadata(messages: SkillCaptureMessage[]): SkillCaptureMessage[] {
  return messages.map((message) =>
    ["tool_call", "tool_result"].includes(message.role)
      ? { ...message, tool_call_id: "[tool id truncated]", tool_name: undefined }
      : message,
  );
}

function fitMessagesToBudget(
  messages: SkillCaptureMessage[],
  prefix: SkillCaptureMessage[],
  maxBytes: number,
): SkillCaptureMessage[] {
  if (skillMessagesBytes([...prefix, ...messages]) <= maxBytes) return messages;

  let fitted = messages;
  const withTruncatedContent = (items: SkillCaptureMessage[]): SkillCaptureMessage[] =>
    items.map((message) => ({ ...message, content: "\n" + TRACE_TRUNCATED }));
  if (skillMessagesBytes([...prefix, ...withTruncatedContent(fitted)]) > maxBytes) {
    fitted = compactToolMetadata(fitted);
  }

  fitted = withTruncatedContent(fitted);
  for (const [index, message] of messages.entries()) {
    const points = Array.from(message.content.trim());
    let low = 0;
    let high = points.length;
    const current = fitted[index]!;
    let best = current;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate: SkillCaptureMessage = { ...current, content: contentWithTrace(points, middle) };
      const candidateMessages = [...fitted];
      candidateMessages[index] = candidate;
      if (skillMessagesBytes([...prefix, ...candidateMessages]) <= maxBytes) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    fitted[index] = best;
  }
  return fitted;
}

function filterPairedSkillMessages(messages: SkillCaptureMessage[]): SkillCaptureMessage[] {
  const calls = new Set(messages.filter((m) => m.role === "tool_call").map((m) => m.tool_call_id));
  const results = new Set(
    messages.filter((m) => m.role === "tool_result").map((m) => m.tool_call_id),
  );
  return messages.filter(
    (message) =>
      !["tool_call", "tool_result"].includes(message.role) ||
      (calls.has(message.tool_call_id) && results.has(message.tool_call_id)),
  );
}

function finalSkillUnit(messages: SkillCaptureMessage[]): {
  messages: SkillCaptureMessage[];
  indexes: Set<number>;
} {
  const lastIndex = messages.length - 1;
  const last = messages[lastIndex];
  if (!last || !["tool_call", "tool_result"].includes(last.role) || !last.tool_call_id) {
    return { messages: last ? [last] : [], indexes: new Set([lastIndex]) };
  }

  const counterpartRole = last.role === "tool_call" ? "tool_result" : "tool_call";
  for (let index = lastIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate && candidate.role === counterpartRole && candidate.tool_call_id === last.tool_call_id) {
      return { messages: [candidate, last], indexes: new Set([index, lastIndex]) };
    }
  }
  return { messages: [last], indexes: new Set([lastIndex]) };
}

function boundSkillMessages(messages: SkillCaptureMessage[], maxBytes: number): SkillCaptureMessage[] {
  if (messages.length === 0) return [];
  if (messages.length <= MAX_SKILL_MESSAGES && skillMessagesBytes(messages) <= maxBytes) {
    return filterPairedSkillMessages(messages);
  }

  const marker: SkillCaptureMessage = { role: "assistant", content: TRACE_TRUNCATED };
  const unit = finalSkillUnit(messages);
  const reserveMarker = messages.length > unit.messages.length;
  const finalMessages = fitMessagesToBudget(
    unit.messages,
    reserveMarker ? [marker] : [],
    maxBytes,
  );
  const candidates = messages.filter((_, index) => !unit.indexes.has(index));
  const selected: SkillCaptureMessage[] = [];

  for (const message of candidates) {
    if (selected.length >= MAX_SKILL_MESSAGES - finalMessages.length - 1) break;
    if (skillMessagesBytes([...selected, message, marker, ...finalMessages]) > maxBytes) break;
    selected.push(message);
  }

  const truncated = selected.length < candidates.length;
  return filterPairedSkillMessages([...selected, ...(truncated ? [marker] : []), ...finalMessages]);
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
