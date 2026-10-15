import { describe, expect, it, vi } from 'vitest';
import { addCreatedMember, createAccount, type CreatedAccount } from '../web/src/components/team/newMemberFlow';

const account: CreatedAccount = { username: 'alice', userId: 'usr-alice', keyValue: 'one-time-key' };

describe('new team member recovery', () => {
  it('keeps the created account and key when adding the member fails; retry never creates another account', async () => {
    const add = vi.fn().mockRejectedValueOnce(new Error('403')).mockResolvedValueOnce(undefined);
    const listMembers = vi.fn().mockResolvedValue([]);
    const first = await addCreatedMember(account, { add, listMembers }, false);
    expect(first.status).toBe('pending');
    expect(first.account).toEqual(account);
    expect(await addCreatedMember(first.account, { add, listMembers }, true)).toMatchObject({ status: 'added' });
    expect(add).toHaveBeenCalledTimes(2);
  });

  it('checks the team before retrying an uncertain add response', async () => {
    const add = vi.fn().mockRejectedValue(new Error('network'));
    const listMembers = vi.fn().mockResolvedValue([{ user_id: account.userId, status: 'active' }]);
    expect(await addCreatedMember(account, { add, listMembers }, false)).toMatchObject({ status: 'added' });
    expect(await addCreatedMember(account, { add, listMembers }, true)).toMatchObject({ status: 'added' });
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('does not send another add while membership lookup is unavailable', async () => {
    const add = vi.fn();
    const result = await addCreatedMember(account, {
      add,
      listMembers: vi.fn().mockRejectedValue(new Error('network')),
    }, true);
    expect(result.status).toBe('pending');
    expect(add).not.toHaveBeenCalled();
  });

  it('keeps the original one-time key on a successful create response', async () => {
    const create = vi.fn().mockResolvedValue({ user_id: account.userId, default_user_key: account.keyValue });
    const findUsers = vi.fn();
    expect(await createAccount('alice', create, findUsers)).toEqual({
      status: 'known', account, recovered: false,
    });
    expect(findUsers).not.toHaveBeenCalled();
  });

  it('looks up an ambiguous create response without sending another create', async () => {
    const create = vi.fn().mockRejectedValue(new TypeError('network'));
    const findUsers = vi.fn().mockResolvedValue([{ username: 'alice', user_id: account.userId }]);
    expect(await createAccount('alice', create, findUsers)).toEqual({
      status: 'known', account: { ...account, keyValue: '', recovered: true }, recovered: true,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('blocks creation when the lookup cannot establish the outcome', async () => {
    const create = vi.fn().mockRejectedValue(new TypeError('network'));
    const findUsers = vi.fn().mockResolvedValue([]);
    expect(await createAccount('alice', create, findUsers)).toEqual({ status: 'unconfirmed' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not treat a rejected duplicate as a newly created account', async () => {
    const rejected = Object.assign(new Error('duplicate username'), { status: 409 });
    const findUsers = vi.fn();
    await expect(createAccount('alice', vi.fn().mockRejectedValue(rejected), findUsers)).rejects.toBe(rejected);
    expect(findUsers).not.toHaveBeenCalled();
  });
});
