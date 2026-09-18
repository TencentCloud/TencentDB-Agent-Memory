export const TOOL_INPUT_MAX_BYTES = 8 * 1024;
export const TOOL_RESULT_MAX_BYTES = 32 * 1024;
export const TURN_MAX_BYTES = 128 * 1024;

const redacted = '<REDACTED>';
const unserializable = '<UNSERIALIZABLE>';
const sensitiveKeys = new Set([
  'authorization',
  'apikey',
  'token',
  'password',
  'secret',
  'awssecretaccesskey',
  'openaikey',
  'anthropickey',
]);

const normalizeKey = (key) => key.toLowerCase().replace(/[_-]/g, '');

const redactString = (value) => value
  .replace(/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/gi, redacted)
  .replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${redacted}`)
  .replace(
    /\b(aws[_-]?secret[_-]?access[_-]?key|openai[_-]?api[_-]?key|anthropic[_-]?api[_-]?key|authorization|api[_-]?key|token|password|secret)\b\s*([=:])[^\r\n]*/gi,
    (match, key, separator) => `${key}${separator}${redacted}`,
  );

const stableValue = (value, ancestors) => {
  if (value === undefined) return null;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new Error('unserializable');
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error('unserializable');
    ancestors.add(value);
    try {
      return value.map((item) => stableValue(item, ancestors));
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value === 'object') {
    if (ancestors.has(value)) throw new Error('unserializable');
    ancestors.add(value);
    try {
      const result = {};
      for (const key of Object.keys(value).sort()) {
        result[key] = sensitiveKeys.has(normalizeKey(key))
          ? redacted
          : stableValue(value[key], ancestors);
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  }
  throw new Error('unserializable');
};

const truncateUtf8 = (content, maxBytes) => {
  const originalBytes = Buffer.byteLength(content, 'utf8');
  if (originalBytes <= maxBytes) return content;
  const marker = `<TRUNCATED original_bytes=${originalBytes}>`;
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (markerBytes > maxBytes) throw new Error('SanitizationError');

  const prefixBudget = maxBytes - markerBytes;
  let prefix = '';
  let usedBytes = 0;
  for (const character of content) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (usedBytes + characterBytes > prefixBudget) break;
    prefix += character;
    usedBytes += characterBytes;
  }
  return `${prefix}${marker}`;
};

export function sanitizeToolContent(value, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error('Invalid maxBytes');
  let serialized;
  try {
    serialized = typeof value === 'string'
      ? value
      : JSON.stringify(stableValue(value, new Set()));
  } catch {
    serialized = unserializable;
  }
  return truncateUtf8(redactString(serialized), maxBytes);
}
