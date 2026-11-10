import { describe, expect, it } from 'vitest';
import { isSensitiveLogKey, sanitizeMetaBody } from '../src/panel/kernel/transport-fetch.js';

const LONG_KEY = 'sk-mem-0123456789abcdef0123456789abcdef';

describe('transport-fetch log redaction', () => {
  it('redacts camelCase / kebab-case credential fields', () => {
    const out = sanitizeMetaBody({
      userKey: LONG_KEY,
      'x-tdai-user-key': LONG_KEY,
      apiKey: LONG_KEY,
      accessToken: LONG_KEY,
      client_secret: LONG_KEY,
    }) as Record<string, string>;
    for (const v of Object.values(out)) expect(v).toBe('sk-mem-0…');
  });

  it('never prints any part of a password or a short secret', () => {
    expect(
      sanitizeMetaBody({ password: 'hunter2', initial_password: 'a-very-long-password-123456', token: 'abc' }),
    ).toEqual({ password: '[redacted]', initial_password: '[redacted]', token: '[redacted]' });
  });

  it('leaves ordinary fields untouched', () => {
    const input = { max_tokens: 1, keyword: 'k', user_id: 'u', items: [{ name: 'n' }] };
    expect(sanitizeMetaBody(input)).toEqual(input);
  });

  it('still matches the original exact-key list', () => {
    for (const k of ['default_user_key', 'key_value', 'granted_by_key', 'owner_user_key', 'authorization', 'bearer']) {
      expect(isSensitiveLogKey(k)).toBe(true);
    }
  });
});
