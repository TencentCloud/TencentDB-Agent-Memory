/**
 * API trace 日志脱敏与序列化（多模块复用）。
 */
import { maskKeyValue } from "../metadata/utils/user-key.js";

export const API_TRACE_SENSITIVE_KEYS = new Set([
  "password",
  "initial_password",
  "default_user_key",
  "default_key_value",
  "user_key",
  "key_value",
  "granted_by_key",
  "owner_user_key",
  "creator_user_key",
  "authorization",
  "api_key",
  "x_api_key",
  "secret_key",
  "private_key",
  "token",
  "access_token",
  "refresh_token",
  "secret",
  "bearer",
]);

function normalizeApiTraceKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

const NORMALIZED_API_TRACE_SENSITIVE_KEYS = new Set(
  [...API_TRACE_SENSITIVE_KEYS].map(normalizeApiTraceKey),
);
const API_TRACE_SENSITIVE_SUFFIXES = ["password", "secret", "token", "apikey"];

export function isApiTraceSensitiveKey(key: string): boolean {
  const normalized = normalizeApiTraceKey(key);
  return NORMALIZED_API_TRACE_SENSITIVE_KEYS.has(normalized)
    || API_TRACE_SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function sanitizeSensitiveApiValue(key: string, raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "[redacted]";
  if (normalizeApiTraceKey(key).endsWith("password")) return "[redacted]";
  return maskKeyValue(raw);
}

export function truncateApiString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…[truncated ${value.length - maxChars} chars]`;
}

export function sanitizeApiField(
  key: string,
  raw: unknown,
  maxFieldChars: number,
  depth = 0,
): unknown {
  if (isApiTraceSensitiveKey(key)) {
    return sanitizeSensitiveApiValue(key, raw);
  }
  return sanitizeApiPayload(raw, maxFieldChars, depth);
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
    out[key] = sanitizeApiField(key, raw, maxFieldChars, depth + 1);
  }
  return out;
}

const SAFE_ERROR_NAMES = new Set([
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "URIError",
  "EvalError", "AggregateError", "MetadataError", "DuplicateUserKeyError",
]);
const SAFE_ERROR_CODES = new Set<unknown>([
  "permission_denied", "invalid_credentials", "invalid_password", "missing_instance_id",
  "invalid_instance_id", "missing_team_id", "duplicate_entry", "duplicate_user_key",
  "already_initialized", "user_inactive", "user_key_not_found", "agent_team_mismatch",
  "task_agent_not_linked", "key_limit_exceeded", "user_limit_exceeded", "team_limit_exceeded",
  "last_key_cannot_revoke", "last_system_admin", "member_already_exists", "asset_not_bindable",
  "filter_not_allowed", "invalid_user_ids", 11000,
]);

/** 默认拒绝原始 message/stack/cause；业务错误也可能插入用户输入，不能按类型直接放行。 */
export function summarizeApiError(error: unknown): string {
  try {
    if (!(error instanceof Error)) return "UnknownError: [redacted]";
    const rawName = error.name;
    const name = SAFE_ERROR_NAMES.has(rawName) ? rawName : "Error";
    const code = (error as Error & { code?: unknown }).code;
    return `${name}${SAFE_ERROR_CODES.has(code) ? ` code=${code}` : ""}: [redacted]`;
  } catch {
    // 异常对象的属性 getter 也不可信，不让日志处理本身改变业务异常传播。
    return "UnknownError: [redacted]";
  }
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
      if (p.length > 32 && /^uk_|sk_|sk-mem-|Bearer /i.test(p)) return "[redacted]";
      return truncateApiString(p, maxFieldChars);
    }
    return p;
  });
}
