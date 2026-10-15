export interface DirectoryAccount {
  username: string;
  userId: string;
  keyValue: string;
  /** A lookup cannot prove which request created the account or recover its key. */
  recovered: boolean;
}

interface UserLookup {
  user_id: string;
  username: string;
}

type CreationResult =
  | { status: 'known'; account: DirectoryAccount }
  | { status: 'unconfirmed' };

export async function findDirectoryUser(
  username: string,
  list: () => Promise<UserLookup[]>,
): Promise<CreationResult> {
  try {
    const matches = (await list()).filter((user) => user.username === username);
    if (matches.length === 1) {
      return {
        status: 'known',
        account: { username, userId: matches[0].user_id, keyValue: '', recovered: true },
      };
    }
  } catch {
    // Keep the uncertain state until an authorized lookup succeeds.
  }
  return { status: 'unconfirmed' };
}

export async function createDirectoryUser(
  username: string,
  create: () => Promise<{ user_id: string; default_user_key: string }>,
  list: () => Promise<UserLookup[]>,
): Promise<CreationResult> {
  try {
    const user = await create();
    return {
      status: 'known',
      account: {
        username,
        userId: user.user_id,
        keyValue: user.default_user_key ?? '',
        recovered: false,
      },
    };
  } catch (error) {
    const { status, code } = (error ?? {}) as { status?: number; code?: number | string };
    if ((status && status >= 400 && status < 500) || (status === 200 && code !== undefined))
      throw error;
    return findDirectoryUser(username, list);
  }
}
