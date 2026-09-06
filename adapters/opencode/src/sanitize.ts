import type { JsonRecord, SkillMessage } from "./types.js";

const RECALL_BLOCK = /<tencentdb-agent-memory>[\s\S]*?<\/tencentdb-agent-memory>/gi;
const PRIVATE_KEY = /-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/gi;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const CREDENTIAL_URL = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;
const ASSIGNMENT = /(["']?)([A-Za-z_][A-Za-z0-9_-]*)(["']?\s*[:=]\s*)["']?([^"'\s,;}]+)["']?/g;
const LOCAL_PATH = /(?:[A-Za-z]:\\|\/(?:Users|home)\/)[^\s"'<>]+/g;
const TRUNCATED = "\n...[capture truncated]";
const TRACE_TRUNCATED = "[skill trace truncated]";

function sensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return /(api_?key|token|secret|password|passwd|private_?key|credential)/.test(normalized)
    || ["authorization", "proxy_authorization", "cookie", "set_cookie"].includes(normalized);
}

function sensitivePath(value: string): boolean {
  const path = value.replaceAll("\\", "/").toLowerCase();
  return /(^|\/)(\.env(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)$|credentials?(?:\.|$)|secrets?(?:\.|$))/.test(path);
}

export function redactText(value: string): string {
  return value
    .replace(RECALL_BLOCK, "[recalled memory omitted]")
    .replace(PRIVATE_KEY, "[private key redacted]")
    .replace(BEARER, "$1[REDACTED]")
    .replace(CREDENTIAL_URL, "$1[REDACTED]:[REDACTED]@")
    .replace(ASSIGNMENT, (match, quote: string, key: string, separator: string) =>
      sensitiveKey(key) ? `${quote}${key}${separator}\"[REDACTED]\"` : match)
    .replace(LOCAL_PATH, (path) => sensitivePath(path) ? "[sensitive path redacted]" : "[local path]")
    .trim();
}

export function boundText(value: string, maxChars: number): string {
  const redacted = redactText(value);
  if (redacted.length <= maxChars) return redacted;
  return redacted.slice(0, Math.max(0, maxChars - TRUNCATED.length)).trimEnd() + TRUNCATED;
}

function sanitizeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactText(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, seen));
  return Object.fromEntries(Object.entries(value as JsonRecord).map(([key, item]) => [
    key,
    sensitiveKey(key) ? "[REDACTED]" : sanitizeValue(item, seen),
  ]));
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(sanitizeValue(value));
  } catch {
    return "[unserializable value]";
  }
}

function bytes(message: SkillMessage): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8") + 1;
}

export function boundSkillTrace(messages: SkillMessage[], maxBytes: number): SkillMessage[] {
  if (messages.length === 0) return [];
  const selected: SkillMessage[] = [];
  let used = 2;
  for (const message of messages.slice(0, 500)) {
    const size = bytes(message);
    if (used + size > maxBytes) break;
    selected.push(message);
    used += size;
  }
  if (selected.length < messages.length) {
    while (selected.length > 0 && used + bytes({ role: "assistant", content: TRACE_TRUNCATED }) > maxBytes) {
      const removed = selected.pop();
      if (removed) used -= bytes(removed);
    }
    selected.push({ role: "assistant", content: TRACE_TRUNCATED });
  }
  const calls = new Set(selected.filter((m) => m.role === "tool_call").map((m) => m.tool_call_id));
  const results = new Set(selected.filter((m) => m.role === "tool_result").map((m) => m.tool_call_id));
  return selected.filter((m) => !["tool_call", "tool_result"].includes(m.role)
    || (!!m.tool_call_id && calls.has(m.tool_call_id) && results.has(m.tool_call_id)));
}

export function textParts(parts: JsonRecord[], maxChars: number): string {
  return boundText(parts
    .filter((part) => part.type === "text" && part.synthetic !== true && part.ignored !== true)
    .map((part) => typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n\n"), maxChars);
}
