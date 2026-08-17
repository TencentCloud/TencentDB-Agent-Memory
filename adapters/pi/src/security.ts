const SECRET_PATTERNS: RegExp[] = [
  /\bsk-mem-[A-Za-z0-9_-]+\b/g,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~-]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redactText(value: string): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, "[REDACTED]");
  return result;
}

// Keys whose values are secret-shaped: replaced wholesale rather than running
// the value through redactText, so a short token without a recognisable prefix
// (e.g. a bare UUID used as a password) is still never written into a Skill
// conversation. Matched case-insensitively against the whole key name.
const SENSITIVE_KEY = /(authorization|api[-_]?key|token|password|passwd|secret|cookie|credential|private[-_]?key)/i;
const MAX_REDACT_DEPTH = 8;

/**
 * Recursively redact a structured value (tool arguments / tool results) before
 * it becomes a Skill message. Unlike `redactText`, which only catches
 * secret-looking substrings, this also blanks entire values under sensitive
 * keys and bounds recursion depth so an adversarial or cyclic payload cannot
 * cause unbounded work.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value;
  if (depth >= MAX_REDACT_DEPTH) return "[...]";
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(item, depth + 1);
    }
    return result;
  }
  return value;
}

export function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  if (maxBytes <= 0) return "";

  const suffix = "\n[truncated]";
  const ellipsisBytes = Buffer.byteLength("…");
  // Prefer the informative suffix when it fits; fall back to a short ellipsis;
  // if even the ellipsis does not fit, drop the marker rather than exceed the budget.
  const marker = Buffer.byteLength(suffix) >= maxBytes ? "…" : suffix;
  const prefixBudget = maxBytes - Buffer.byteLength(marker);
  if (prefixBudget < 0) return truncatePrefix(bytes, maxBytes);
  return `${truncatePrefix(bytes, prefixBudget)}${marker}`;
}

function truncatePrefix(bytes: Buffer, maxBytes: number): string {
  let end = Math.min(bytes.length, maxBytes);
  if (end === 0) return "";

  // Back over trailing continuation bytes so bytes[end-1] is ASCII or the lead
  // byte of a multi-byte character.
  while (end > 0 && ((bytes[end - 1] ?? 0) & 0xc0) === 0x80) end -= 1;
  if (end === 0) return "";

  // If the last kept byte starts a multi-byte character, it must be kept whole
  // or dropped entirely - never leave an orphaned lead byte that decodes to U+FFFD.
  const last = bytes[end - 1] ?? 0;
  if ((last & 0xc0) === 0xc0) {
    const expectedLength = last < 0xe0 ? 2 : last < 0xf0 ? 3 : 4;
    const endOfChar = end - 1 + expectedLength;
    if (endOfChar > maxBytes) {
      end -= 1; // whole character does not fit; drop it
    } else {
      end = Math.min(bytes.length, endOfChar); // character fits; include its continuation bytes
    }
  }
  return bytes.subarray(0, end).toString("utf8");
}
