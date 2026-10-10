const SECRET_PATTERNS: RegExp[] = [
  /\bsk-mem-[A-Za-z0-9_-]+\b/g,
  /\bsk\s*-\s*[A-Za-z0-9_-]{12,}\b/g,
  /\bsk_live_[0-9A-Za-z]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~-]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bnpm_[A-Za-z0-9]{36,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
];

const SENSITIVE_FIELD = String.raw`(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|client[_-]?secret|auth(?:orization)?|credential|private[_-]?key)`;
const SENSITIVE_KEY = new RegExp(`^${SENSITIVE_FIELD}$`, "i");
// For non-JSON text there is no trustworthy end-of-value boundary (YAML block
// scalars, folded headers, broken JSON, etc.). Hide the remainder rather than
// accidentally returning part of a credential.
const SENSITIVE_TEXT_TAIL = new RegExp(`(\\b${SENSITIVE_FIELD}\\b["']?\\s*[:=])[\\s\\S]*`, "i");

export function redactForgetPreview(value: string): string {
  let result: string;
  try {
    // The reviver visits nested objects and arrays and replaces the ENTIRE
    // value of a sensitive field, including arrays, objects and null.
    const parsed: unknown = JSON.parse(value, (key, fieldValue: unknown) => {
      if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
      // JSON may also contain a string holding a header or a YAML fragment.
      return typeof fieldValue === "string"
        ? fieldValue.replace(SENSITIVE_TEXT_TAIL, "$1 [REDACTED]")
        : fieldValue;
    });
    result = JSON.stringify(parsed);
  } catch {
    result = value.replace(SENSITIVE_TEXT_TAIL, "$1 [REDACTED]");
  }
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, "[REDACTED]");
  return result;
}

export function truncateForgetPreview(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return value;
  if (maxBytes <= 0) return "";

  const longMarker = "\n[truncated]";
  if (maxBytes < Buffer.byteLength("…")) return truncatePrefix(encoded, maxBytes);
  const marker = Buffer.byteLength(longMarker) < maxBytes ? longMarker : "…";
  const prefixBudget = Math.max(0, maxBytes - Buffer.byteLength(marker));
  return `${truncatePrefix(encoded, prefixBudget)}${marker}`;
}

function truncatePrefix(bytes: Buffer, maxBytes: number): string {
  let end = Math.min(bytes.length, maxBytes);
  if (end === 0) return "";

  while (end > 0 && ((bytes[end - 1] ?? 0) & 0xc0) === 0x80) end -= 1;
  if (end === 0) return "";

  const last = bytes[end - 1] ?? 0;
  if ((last & 0xc0) === 0xc0) {
    const expectedLength = last < 0xe0 ? 2 : last < 0xf0 ? 3 : 4;
    const characterEnd = end - 1 + expectedLength;
    if (characterEnd > maxBytes) end -= 1;
    else end = Math.min(bytes.length, characterEnd);
  }
  return bytes.subarray(0, end).toString("utf8");
}

export function renderForgetPreview(value: string, maxBytes = 320): string {
  const plainText = value.replace(/<\/?mark>/gi, "");
  return truncateForgetPreview(redactForgetPreview(plainText).trim(), maxBytes);
}
