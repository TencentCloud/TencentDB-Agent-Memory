import { describe, expect, it, vi } from 'vitest';
import { createDirectoryUser, findDirectoryUser } from '../web/src/pages/UsersPage/createUser';

describe('independent user creation', () => {
  it('returns the one-time key only from a confirmed create response', async () => {
    const list = vi.fn();
    const result = await createDirectoryUser('alice', vi.fn().mockResolvedValue({
      user_id: 'usr-alice', default_user_key: 'one-time-key',
    }), list);
    expect(result).toEqual({
      status: 'known',
      account: { username: 'alice', userId: 'usr-alice', keyValue: 'one-time-key', recovered: false },
    });
    expect(list).not.toHaveBeenCalled();
  });

  it('reconciles a lost create response without sending another create or inventing a key', async () => {
    const create = vi.fn().mockRejectedValue(new TypeError('network'));
    const list = vi.fn().mockResolvedValue([{ username: 'alice', user_id: 'usr-alice' }]);
    expect(await createDirectoryUser('alice', create, list)).toEqual({
      status: 'known',
      account: { username: 'alice', userId: 'usr-alice', keyValue: '', recovered: true },
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('keeps an ambiguous outcome blocked until the lookup can confirm it', async () => {
    const create = vi.fn().mockRejectedValue(new TypeError('network'));
    expect(await createDirectoryUser('alice', create, vi.fn().mockResolvedValue([])))
      .toEqual({ status: 'unconfirmed' });
    expect(await findDirectoryUser('alice', vi.fn().mockRejectedValue(new Error('offline'))))
      .toEqual({ status: 'unconfirmed' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('reports a rejected create without treating an existing account as newly created', async () => {
    const rejected = Object.assign(new Error('duplicate'), { status: 409 });
    const list = vi.fn();
    await expect(createDirectoryUser('alice', vi.fn().mockRejectedValue(rejected), list))
      .rejects.toBe(rejected);
    expect(list).not.toHaveBeenCalled();
  });

  it('treats a rejected metadata envelope as definitive even when HTTP was 200', async () => {
    const rejected = Object.assign(new Error('duplicate'), { status: 200, code: 'duplicate_username' });
    const list = vi.fn();
    await expect(createDirectoryUser('alice', vi.fn().mockRejectedValue(rejected), list))
      .rejects.toBe(rejected);
    expect(list).not.toHaveBeenCalled();
  });
});
