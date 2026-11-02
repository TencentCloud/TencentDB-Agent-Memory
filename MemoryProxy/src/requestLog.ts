/**
 * Request debug logging and safe request-parameter projection.
 */

import type { ProxyConfig } from "./types.js";
import { log } from "./report/log.js";

const REDACTED = "[REDACTED]";
const LARGE_LOG_FIELDS = new Set(["input", "messages", "tools", "system", "instructions"]);
const SENSITIVE_KEYS = new Set([
  "apikey",
  "authorization",
  "xapikey",
  "accesstoken",
  "bearertoken",
  "token",
  "password",
  "secret",
  "clientsecret",
  "secretkey",
  "cookie",
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function redactSecrets(value: unknown, seen: WeakSet<object>): unknown {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.map((item) => redactSecrets(item, seen));
    seen.delete(value);
    return result;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.has(normalizedKey(key))
      ? REDACTED
      : redactSecrets(child, seen);
  }
  seen.delete(value);
  return out;
}

/**
 * Copy a complete outbound request body while recursively redacting auth
 * secrets. Suitable for protected tracing systems, not ordinary logs.
 */
export function buildSafeTraceRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  return redactSecrets(body, new WeakSet<object>()) as Record<string, unknown>;
}

/**
 * Build compact log fields. Large prompt/schema fields are represented only by
 * counts or lengths; all other top-level request parameters are preserved.
 */
export function buildSafeRequestParameters(body: Record<string, unknown>): Record<string, unknown> {
  const parameters: Record<string, unknown> = {};
  const seen = new WeakSet<object>();
  for (const [key, value] of Object.entries(body)) {
    if (LARGE_LOG_FIELDS.has(key)) continue;
    parameters[key] = SENSITIVE_KEYS.has(normalizedKey(key))
      ? REDACTED
      : redactSecrets(value, seen);
  }
  if (Array.isArray(body.input)) parameters.input_count = body.input.length;
  else if (typeof body.input === "string") parameters.input_chars = body.input.length;
  if (Array.isArray(body.messages)) parameters.messages_count = body.messages.length;
  if (Array.isArray(body.tools)) parameters.tools_count = body.tools.length;
  if (typeof body.system === "string") parameters.system_chars = body.system.length;
  else if (Array.isArray(body.system)) parameters.system_blocks = body.system.length;
  if (typeof body.instructions === "string") {
    parameters.instructions_chars = body.instructions.length;
  }
  return parameters;
}

/** Write compact request details. Large fields and secrets are never logged. */
export function writeRequestLog(
  config: ProxyConfig,
  body: Record<string, unknown>,
  requestId?: string,
  clientRequestId?: string,
): void {
  if (config.log.level !== "debug") return;
  log.debug("request.body", {
    requestId,
    clientRequestId,
    parameters: buildSafeRequestParameters(body),
  });
}
