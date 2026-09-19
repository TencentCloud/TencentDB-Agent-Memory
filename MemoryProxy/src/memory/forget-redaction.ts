const SECRET_PATTERNS: RegExp[] = [
  /\bsk-mem-[A-Za-z0-9_-]+\b/g,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
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

export function redactForgetPreview(value: string): string {
  let result = value;
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
  return truncateForgetPreview(redactForgetPreview(value).trim(), maxBytes);
}
