import { describe, expect, it } from 'vitest';
import { isCurrentSessionKey } from '../web/src/lib/current-session-key';

describe('current session Key identity', () => {
  it('does not confuse Keys with the same visible suffix when the Key ID is known', () => {
    const session = { instanceId: 'instance', userKey: 'sk-mem-first-abcd', keyId: 'key-one' };
    const first = { key_id: 'key-one', key_prefix: 'sk-mem-****abcd' };
    const second = { key_id: 'key-two', key_prefix: 'sk-mem-****abcd' };
    expect(isCurrentSessionKey(session, first, true)).toBe(true);
    expect(isCurrentSessionKey(session, second, true)).toBe(false);
    expect(isCurrentSessionKey(session, first, false)).toBe(false);
  });

  it('keeps conservative protection when an older Core omits the Key ID', () => {
    const session = { instanceId: 'instance', userKey: 'sk-mem-first-abcd' };
    const key = { key_id: 'key-two', key_prefix: 'sk-mem-****abcd' };
    expect(isCurrentSessionKey(session, key, true)).toBe(true);
  });
});
