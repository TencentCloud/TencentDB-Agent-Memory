// Independent redaction module: all secret-scrubbing for recalled data and captured
// turns lives here so it can be audited and tested in isolation. Recalled memory is
// treated as untrusted data that may contain historical secrets; this layer reduces
// (but does not guarantee elimination of) leakage into model context or storage.

const RECALL_BEGIN = "BEGIN_TENCENTDB_RECALLED_MEMORY";
const RECALL_END = "END_TENCENTDB_RECALLED_MEMORY";

// Hoisted regexes: redact() is called per message, so avoid recompiling constants.
// String.replace with a global regex does not rely on lastIndex in V8, so these
// module-level instances are safe to reuse across calls.
const RECALL_CLOSED_RE = new RegExp(`${RECALL_BEGIN}[\\s\\S]*?${RECALL_END}`, "g");
const RECALL_UNCLOSED_RE = new RegExp(`${RECALL_BEGIN}[\\s\\S]*$`);
const RECALL_MARKER_RE = new RegExp(`${RECALL_BEGIN}|${RECALL_END}`, "g");

export function sensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return (
    /(api_?key|token|secret|password|passwd|private_?key|credential)/.test(normalized) ||
    ["authorization", "proxy_authorization", "cookie", "set_cookie"].includes(normalized)
  );
}

export function redact(value: string): string {
  return value
    // Closed recall block.
    .replace(RECALL_CLOSED_RE, "[recalled memory omitted]")
    // Unclosed recall block (BEGIN with no END, e.g. truncated by Pi or pasted by user).
    .replace(RECALL_UNCLOSED_RE, "[recalled memory omitted]")
    // Standalone recall markers that remain after whole-block removal.
    .replace(RECALL_MARKER_RE, "[recalled memory marker omitted]")
    // Bearer tokens.
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    // Private key blocks (closed and unclosed).
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/gi, "[private key redacted]")
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*$/i, "[private key redacted]")
    // Credentials embedded in URLs: scheme://user:pass@host
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, "$1[REDACTED]:[REDACTED]@")
    // Sensitive key with a quoted value (may contain spaces): key="my secret value"
    .replace(
      /(["']?)([A-Za-z_][A-Za-z0-9_-]*)(["']?\s*[:=]\s*)(["'])([^"']*)(["'])/g,
      (_match, q1: string, key: string, sep: string, q2: string, _val: string, q3: string) =>
        sensitiveKey(key) ? `${q1}${key}${sep}${q2}[REDACTED]${q3}` : _match,
    )
    // Sensitive key with an unquoted value (no spaces): key=value. Only '=' is matched
    // here; ':' is left for the quoted/JSON rule above so natural language like
    // "Authorization: Bearer ..." is not clobbered by the key rule.
    .replace(
      /(["']?)([A-Za-z_][A-Za-z0-9_-]*)(["']?\s*=\s*)([^"'\s,;}]+)/g,
      (match, q1: string, key: string, sep: string) =>
        sensitiveKey(key) ? `${q1}${key}${sep}"[REDACTED]"` : match,
    )
    .trim();
}

export function sanitizeStructured(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") return redact(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((item) => sanitizeStructured(item, seen));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      sensitiveKey(key) ? "[REDACTED]" : sanitizeStructured(item, seen),
    ]),
  );
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(sanitizeStructured(value));
  } catch {
    return "[unserializable arguments]";
  }
}
