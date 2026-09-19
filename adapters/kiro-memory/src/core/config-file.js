import { readFile as defaultReadFile } from 'node:fs/promises';

const allowedKeys = new Set([
  'version', 'gatewayUrl', 'serviceId', 'teamId', 'agentId', 'userId', 'stateDir',
  'recallEnabled', 'captureEnabled', 'conversationRecallEnabled', 'skillRecallEnabled',
  'timeoutMs', 'maxRecallResults', 'maxContextChars', 'mcpMaxOutputChars', 'logLevel',
]);
const secretLike = /api.?key|token|password|authorization/i;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const assertNoDuplicateKeys = (text) => {
  let index = 0;
  const whitespace = () => { while (/\s/u.test(text[index] ?? '')) index += 1; };
  const string = () => {
    const start = index;
    index += 1;
    while (index < text.length) {
      if (text[index] === '\\') { index += 2; continue; }
      if (text[index] === '"') { index += 1; return JSON.parse(text.slice(start, index)); }
      index += 1;
    }
    throw new Error('invalid');
  };
  const value = () => {
    whitespace();
    if (text[index] === '{') {
      index += 1; whitespace();
      const keys = new Set();
      if (text[index] === '}') { index += 1; return; }
      while (index < text.length) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new Error('duplicate');
        keys.add(key);
        whitespace(); index += 1;
        value(); whitespace();
        if (text[index] === '}') { index += 1; return; }
        index += 1;
      }
      return;
    }
    if (text[index] === '[') {
      index += 1; whitespace();
      if (text[index] === ']') { index += 1; return; }
      while (index < text.length) {
        value(); whitespace();
        if (text[index] === ']') { index += 1; return; }
        index += 1;
      }
      return;
    }
    if (text[index] === '"') { string(); return; }
    while (index < text.length && !/[\s,}\]]/u.test(text[index])) index += 1;
  };
  value(); whitespace();
  if (index !== text.length) throw new Error('invalid');
};

const findSecretKey = (value, prefix = '') => {
  if (!isObject(value) && !Array.isArray(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (secretLike.test(key)) return path;
    const nested = findSecretKey(child, path);
    if (nested) return nested;
  }
  return null;
};

export async function readConfigLayer(path, source, { readFile = defaultReadFile, error } = {}) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    if (cause?.code === 'ENOENT') return null;
    throw error('$', source, 'read_failed');
  }
  let value;
  try {
    value = JSON.parse(text);
    assertNoDuplicateKeys(text);
  } catch {
    throw error('$', source, 'invalid_json');
  }
  if (!isObject(value)) throw error('$', source, 'invalid_shape');
  const secret = findSecretKey(value);
  if (secret) throw error(secret, source, 'secret_forbidden');
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw error(key, source, 'unknown_field');
  }
  if (value.version !== 2) throw error('version', source, 'unsupported_version');
  const { version: _version, ...fields } = value;
  return fields;
}
