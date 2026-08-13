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

export function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  if (maxBytes <= 0) return "";

  const suffix = "\n[truncated]";
  if (Buffer.byteLength(suffix) >= maxBytes) {
    return `${truncatePrefix(bytes, Math.max(0, maxBytes - Buffer.byteLength("…")))}…`;
  }
  return `${truncatePrefix(bytes, maxBytes - Buffer.byteLength(suffix))}${suffix}`;
}

function truncatePrefix(bytes: Buffer, maxBytes: number): string {
  let end = Math.min(bytes.length, maxBytes);
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  if (end === 0) return "";

  const lead = bytes[end - 1] ?? 0;
  const expectedLength = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf8 ? 4 : 1;
  if (end - 1 + expectedLength > maxBytes) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}
