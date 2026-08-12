import type { CaptureTurn, SkillCaptureMessage } from "./client.js";

const RECALL_BEGIN = "BEGIN_TENCENTDB_RECALLED_MEMORY";
const RECALL_END = "END_TENCENTDB_RECALLED_MEMORY";
const TRUNCATED = "\n...[capture truncated]";
const TRACE_TRUNCATED = "[skill trace truncated]";
const MAX_SKILL_MESSAGES = 500;
const MAX_L0_CHARS = 8_192;

function sensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return (
    /(api_?key|token|secret|password|passwd|private_?key|credential)/.test(normalized) ||
    ["authorization", "proxy_authorization", "cookie", "set_cookie"].includes(normalized)
  );
}

function truncate(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, Math.max(0, maxChars - TRUNCATED.length)).trimEnd() + TRUNCATED;
}

function redact(value: string): string {
  return value
    .replace(new RegExp(`${RECALL_BEGIN}[\\s\\S]*?${RECALL_END}`, "g"), "[recalled memory omitted]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/gi, "[private key redacted]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, "$1[REDACTED]:[REDACTED]@")
    .replace(
      /(["']?)([A-Za-z_][A-Za-z0-9_-]*)(["']?\s*[:=]\s*)["']?([^"'\s,;}]+)["']?/g,
      (match, quote: string, key: string, separator: string) =>
        sensitiveKey(key) ? `${quote}${key}${separator}\"[REDACTED]\"` : match,
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

function messageBytes(message: SkillCaptureMessage): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}

function boundSkillMessages(messages: SkillCaptureMessage[], maxBytes: number): SkillCaptureMessage[] {
  if (messages.length === 0) return [];
  const last = messages.at(-1)!;
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

  const calls = new Set(selected.filter((m) => m.role === "tool_call").map((m) => m.tool_call_id));
  const results = new Set(selected.filter((m) => m.role === "tool_result").map((m) => m.tool_call_id));
  return selected.filter(
    (message) =>
      !["tool_call", "tool_result"].includes(message.role) ||
      (calls.has(message.tool_call_id) && results.has(message.tool_call_id)),
  );
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
  maxSkillBytes = 512_000,
  sourceId?: string,
): CaptureTurn | null {
  const skillChars = Math.min(maxChars, Math.max(500, Math.floor(maxSkillBytes / 4)));
  const skillMessages: SkillCaptureMessage[] = [];
  let finalAssistant = "";
  const users: string[] = [];

  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as Record<string, unknown>;
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : capturedAtMs;

    if (message.role === "user") {
      const user = clean(textContent(message.content), skillChars);
      if (user) {
        users.push(user);
        skillMessages.push({ role: "user", content: user, timestamp });
      }
      continue;
    }

    if (message.role === "assistant" && Array.isArray(message.content)) {
      const assistantParts: string[] = [];
      const flushAssistant = (): void => {
        const assistant = clean(assistantParts.join("\n"), skillChars);
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
            content: clean(safeJson(part.arguments ?? {}), skillChars),
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
        content: clean(textContent(message.content), skillChars) || "[empty tool result]",
        tool_name: typeof message.toolName === "string" ? message.toolName : undefined,
        tool_call_id: message.toolCallId,
        timestamp,
      });
    }
  }

  if (!finalAssistant) return null;
  if (users.length === 0) {
    const fallback = clean(originalPrompt, skillChars);
    if (fallback) {
      users.push(fallback);
      skillMessages.unshift({ role: "user", content: fallback, timestamp: capturedAtMs });
    }
  }
  return {
    sessionId,
    sourceId,
    user: clean(users.join("\n\n--- queued follow-up ---\n\n"), Math.min(maxChars, MAX_L0_CHARS)),
    assistant: clean(finalAssistant, Math.min(maxChars, MAX_L0_CHARS)),
    skillMessages: boundSkillMessages(skillMessages, maxSkillBytes),
    capturedAtMs,
  };
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
