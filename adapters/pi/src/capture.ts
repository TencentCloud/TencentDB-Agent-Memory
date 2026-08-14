/**
 * Converts Pi settled-turn messages into a CaptureTurn for the v3 L0 and Skill
 * pipelines. Transcripts are cleaned: credentials are redacted, oversized
 * payloads are truncated, images are collapsed, and the final assistant text is
 * kept distinct from intermediate tool-use answers.
 */

import type { CaptureTurn, SkillCaptureMessage } from "./client.js";

const RECALL_BEGIN = "BEGIN_TENCENTDB_RECALLED_MEMORY";
const RECALL_END = "END_TENCENTDB_RECALLED_MEMORY";
const TRUNCATED = "\n...[capture truncated]";
const MAX_L0_CHARS = 8_192;
const MAX_SKILL_MESSAGES = 500;

function sensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (
    ["authorization", "proxy_authorization", "cookie", "set_cookie", "pwd", "pin", "passcode", "jwt"].includes(
      normalized,
    )
  ) {
    return true;
  }
  return /(api_?key|access_?key|secret|password|passwd|token|credential|private_?key|signature)/.test(normalized);
}

function truncate(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, Math.max(0, maxChars - TRUNCATED.length)).trimEnd() + TRUNCATED;
}

/**
 * A turn is "completed" only when the assistant message cleanly stopped.
 * Every other StopReason (length, toolUse, error, aborted, pending, deferred)
 * marks an intermediate turn that a later run will supersede.
 */
function isCompletedStop(stopReason: unknown): boolean {
  return String(stopReason) === "stop";
}

function redact(value: string): string {
  return value
    .replace(new RegExp(`${RECALL_BEGIN}[\\s\\S]*?${RECALL_END}`, "g"), "[recalled memory omitted]")
    .replace(new RegExp(RECALL_BEGIN, "g"), "")
    .replace(new RegExp(RECALL_END, "g"), "")
    .replace(/\b(Bearer[\s:=]*)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/gi, "[private key redacted]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, "$1[REDACTED]:[REDACTED]@")
    .replace(
      /(["']?)([A-Za-z_][A-Za-z0-9_-]*)(["']?\s*[:=]\s*)(["'])([^"']+)(["'])/g,
      (match, quote: string, key: string, separator: string) =>
        sensitiveKey(key) ? `${quote}${key}${separator}"[REDACTED]"` : match,
    )
    .replace(
      /(["']?)([A-Za-z_][A-Za-z0-9_-]*)(["']?\s*[:=]\s*)["']?([^"'\s,;}]+)["']?/g,
      (match, quote: string, key: string, separator: string) =>
        sensitiveKey(key) ? `${quote}${key}${separator}"[REDACTED]"` : match,
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

/** Recursively redact sensitive keys inside structured tool arguments. */
function sanitizeStructured(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redact(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeStructured(item, seen));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      sensitiveKey(key) ? "[REDACTED]" : sanitizeStructured(item, seen),
    ]),
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(sanitizeStructured(value));
  } catch {
    return "[unserializable arguments]";
  }
}

function clean(value: string, maxChars: number): string {
  return truncate(redact(value), maxChars);
}

interface RawMessage {
  role?: unknown;
  content?: unknown;
  stopReason?: unknown;
  timestamp?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
}

/**
 * Build a CaptureTurn from a settled turn's messages. Returns null when there
 * is no completed assistant message to capture.
 */
export function buildCaptureTurn(
  sessionId: string,
  originalPrompt: string,
  messages: unknown[],
  maxChars: number,
  capturedAtMs = Date.now(),
): CaptureTurn | null {
  const skillMessages: SkillCaptureMessage[] = [];
  const users: string[] = [];
  let finalAssistant = "";

  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as RawMessage;
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : capturedAtMs;

    if (message.role === "user") {
      const user = clean(textContent(message.content), maxChars);
      if (user) {
        users.push(user);
        skillMessages.push({ role: "user", content: user, timestamp });
      }
      continue;
    }

    if (message.role === "assistant" && Array.isArray(message.content)) {
      const assistantParts: string[] = [];
      const flushAssistant = (): void => {
        const assistant = clean(assistantParts.join("\n"), maxChars);
        assistantParts.length = 0;
        if (!assistant) return;
        skillMessages.push({ role: "assistant", content: assistant, timestamp });
        if (isCompletedStop(message.stopReason)) {
          finalAssistant = assistant;
        }
      };
      for (const rawPart of message.content) {
        if (!rawPart || typeof rawPart !== "object") continue;
        const part = rawPart as { type?: unknown; text?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
        if (part.type === "text" && typeof part.text === "string") {
          assistantParts.push(part.text);
        } else if (part.type === "toolCall" && typeof part.id === "string") {
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

  if (users.length === 0) {
    const fallback = clean(originalPrompt, maxChars);
    if (fallback) {
      users.push(fallback);
      skillMessages.unshift({ role: "user", content: fallback, timestamp: capturedAtMs });
    }
  }

  return {
    sessionId,
    user: clean(users.join("\n\n--- queued follow-up ---\n\n"), Math.min(maxChars, MAX_L0_CHARS)),
    assistant: clean(finalAssistant, Math.min(maxChars, MAX_L0_CHARS)),
    skillMessages: boundSkillMessages(skillMessages, maxChars),
    capturedAtMs,
  };
}

/** Drop orphaned tool messages and cap the total number of skill messages. */
function boundSkillMessages(messages: SkillCaptureMessage[], maxChars: number): SkillCaptureMessage[] {
  // Cap first, then pair: pairing after the cap drops any tool_call/tool_result
  // whose partner was cut off, so the final list never contains an orphan.
  const capped = messages.slice(0, MAX_SKILL_MESSAGES);
  const calls = new Set(capped.filter((m) => m.role === "tool_call").map((m) => m.tool_call_id));
  const results = new Set(capped.filter((m) => m.role === "tool_result").map((m) => m.tool_call_id));
  const paired = capped.filter(
    (m) => !["tool_call", "tool_result"].includes(m.role) || (calls.has(m.tool_call_id) && results.has(m.tool_call_id)),
  );
  return paired.map((m) => ({ ...m, content: truncate(m.content, maxChars) }));
}

/** Whether the message list ends with a cleanly completed assistant turn. */
export function hasCompletedAssistant(messages: unknown[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const raw = messages[index];
    if (!raw || typeof raw !== "object") continue;
    const message = raw as RawMessage;
    if (message.role !== "assistant") continue;
    if (!isCompletedStop(message.stopReason)) return false;
    return textContent(message.content).trim().length > 0;
  }
  return false;
}
