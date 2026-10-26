/**
 * API trace 日志脱敏与序列化（多模块复用）。
 */
import { maskKeyValue } from "../metadata/utils/user-key.js";

export const API_TRACE_SENSITIVE_KEYS = new Set([
  "password",
  "initial_password",
  "default_user_key",
  "user_key",
  "key_value",
  "granted_by_key",
  "owner_user_key",
  "creator_user_key",
  "authorization",
  "api_key",
  "token",
  "secret",
  "bearer",
]);

/**
 * Normalize a field name so `userKey`, `user-key`, `USER_KEY` and `x-tdai-user-key`
 * are compared the same way.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const NORMALIZED_SENSITIVE_KEYS = new Set([...API_TRACE_SENSITIVE_KEYS].map(normalizeKey));
/** Suffixes that mark a field as a credential regardless of prefix (e.g. `new_password`, `accessToken`). */
const SENSITIVE_KEY_SUFFIXES = ["password", "passwd", "secret", "token", "apikey", "userkey", "secretkey", "accesskey", "privatekey"];

export function isSensitiveApiKey(key: string): boolean {
  const n = normalizeKey(key);
  if (!n) return false;
  return NORMALIZED_SENSITIVE_KEYS.has(n) || SENSITIVE_KEY_SUFFIXES.some((s) => n.endsWith(s));
}

/**
 * Mask a sensitive value for logs. Passwords and short values are fully redacted;
 * long keys keep an 8-char prefix so operators can still correlate which key was used.
 */
function maskSensitiveValue(key: string, raw: unknown): string {
  if (typeof raw !== "string" || raw.length <= 16 || /pass(word|wd)/.test(normalizeKey(key))) {
    return "[redacted]";
  }
  return maskKeyValue(raw);
}

export function truncateApiString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…[truncated ${value.length - maxChars} chars]`;
}

export function sanitizeApiPayload(value: unknown, maxFieldChars: number, depth = 0): unknown {
  if (depth > 8) return "[max_depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncateApiString(value, maxFieldChars);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeApiPayload(item, maxFieldChars, depth + 1));
  }
  if (typeof value !== "object") return String(value);

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveApiKey(key)) {
      out[key] = maskSensitiveValue(key, raw);
      continue;
    }
    out[key] = sanitizeApiPayload(raw, maxFieldChars, depth + 1);
  }
  return out;
}

export function serializeForApiLog(value: unknown, maxFieldChars: number, maxJsonChars: number): string {
  try {
    const json = JSON.stringify(sanitizeApiPayload(value, maxFieldChars));
    if (json.length <= maxJsonChars) return json;
    return `${json.slice(0, maxJsonChars)}…[truncated ${json.length - maxJsonChars} chars]`;
  } catch {
    return "[unserializable]";
  }
}

export function redactSqlParams(params: unknown[], maxFieldChars: number): unknown[] {
  return params.map((p) => {
    if (typeof p === "string") {
      if (p.length > 32 && (/^(uk_|sk_|sk-mem-|bearer )/i.test(p) || p.includes("sk-mem-"))) return "[redacted]";
      return truncateApiString(p, maxFieldChars);
    }
    return p;
  });
}
