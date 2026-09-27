/** The one-time key stays in dialog memory until the user closes it. */
export interface CreatedAccount {
  username: string;
  userId: string;
  keyValue: string;
  /** Account found after a create response was lost; creation cannot be attributed to this request. */
  recovered?: boolean;
}

interface UserResult {
  user_id: string;
  username: string;
}
interface MemberResult {
  user_id: string;
  status: string;
}

export async function findAccount(
  username: string,
  findUsers: () => Promise<UserResult[]>,
): Promise<
  { status: 'known'; account: CreatedAccount; recovered: true } | { status: 'unconfirmed' }
> {
  try {
    const matches = (await findUsers()).filter((user) => user.username === username);
    if (matches.length === 1) {
      // A generated key cannot be recovered without the original create response.
      return {
        status: 'known',
        account: { username, userId: matches[0].user_id, keyValue: '', recovered: true },
        recovered: true,
      };
    }
  } catch {
    // Preserve the uncertain state while the lookup is unavailable.
  }
  return { status: 'unconfirmed' };
}

export async function createAccount(
  username: string,
  create: () => Promise<{ user_id: string; default_user_key: string }>,
  findUsers: () => Promise<UserResult[]>,
): Promise<
  { status: 'known'; account: CreatedAccount; recovered: boolean } | { status: 'unconfirmed' }
> {
  try {
    const result = await create();
    return {
      status: 'known',
      account: { username, userId: result.user_id, keyValue: result.default_user_key ?? '' },
      recovered: false,
    };
  } catch (error) {
    // A received client rejection is definitive, including duplicate username.
    // Only a lost response or a server error leaves the create outcome unknown.
    const { status, code } = (error ?? {}) as { status?: number; code?: number | string };
    if ((status && status >= 400 && status < 500) || (status === 200 && code !== undefined))
      throw error;
    return findAccount(username, findUsers);
  }
}

export async function addCreatedMember(
  account: CreatedAccount,
  api: { add: () => Promise<unknown>; listMembers: () => Promise<MemberResult[]> },
  checkBeforeAdd: boolean,
): Promise<{ status: 'added' | 'pending'; account: CreatedAccount; error?: unknown }> {
  const isMember = async () =>
    (await api.listMembers()).some(
      (member) => member.user_id === account.userId && member.status === 'active',
    );

  if (checkBeforeAdd) {
    try {
      if (await isMember()) return { status: 'added', account };
    } catch (error) {
      return { status: 'pending', account, error };
    }
  }

  try {
    await api.add();
    return { status: 'added', account };
  } catch (error) {
    try {
      if (await isMember()) return { status: 'added', account };
    } catch {
      // The add result is still uncertain; retain the account for another check.
    }
    return { status: 'pending', account, error };
  }
}
