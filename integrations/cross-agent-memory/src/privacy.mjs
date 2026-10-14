const REMOVED_MEDIA = "[已移除多媒体数据]";
const DATA_URI_PATTERN = /data:[^,\s]*;base64,[A-Za-z0-9+/=]+/gi;
const LONG_BASE64_PATTERN = /[A-Za-z0-9+/=]{400,}/g;

const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/i,
  /(?:\b(?:api[_-]?key|access[_-]?token|secret[_-]?key|password|passwd|pwd|token)\b|密码)\s*["'＂”’」』]\s*[:=：＝]\s*["'＂“‘「『]?\s*[^\s,;，；:=：＝"'＂“”‘’「」『』{}\[\]]+/iu,
  /\b(?:api[_-]?key|access[_-]?token|secret[_-]?key)\s*[:=]\s*[^\s,;]+/i,
  /(?:\b(?:password|passwd|pwd|token)\b|密码)\s*[:=：＝]\s*[^\s,;，；:=：＝]+/iu,
  /\bsk-[A-Za-z0-9_-]+/i,
  /\bghp_[A-Za-z0-9]+/i,
  /\bgithub_pat_[A-Za-z0-9_]+/i
];

function asText(value) {
  return typeof value === "string" ? value : "";
}

export function hasNoMemoryDirective(text) {
  const value = asText(text);
  return /\[不记忆\]/i.test(value) || /\/nomemory(?![\p{L}\p{N}_])/iu.test(value);
}

export function containsCredential(text) {
  const value = asText(text);
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
}

export function sanitizeText(text, limit) {
  return asText(text)
    .replace(DATA_URI_PATTERN, REMOVED_MEDIA)
    .replace(LONG_BASE64_PATTERN, REMOVED_MEDIA)
    .slice(0, limit);
}

export function inspectTurn(user, assistant) {
  const userText = asText(user);
  const assistantText = asText(assistant);

  return {
    skip: hasNoMemoryDirective(userText) ||
      hasNoMemoryDirective(assistantText) ||
      containsCredential(userText) ||
      containsCredential(assistantText),
    user: sanitizeText(userText, 30_000),
    assistant: sanitizeText(assistantText, 60_000)
  };
}
