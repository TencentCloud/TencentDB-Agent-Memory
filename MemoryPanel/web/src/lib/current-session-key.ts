import type { PanelSession } from './panelSession';

/** Keep the active credential protected when an older Core cannot report its key ID. */
export function isCurrentSessionKey(
  session: PanelSession | null,
  key: { key_id: string; key_prefix?: string },
  isOwnAccount: boolean,
): boolean {
  if (!isOwnAccount || !session?.userKey) return false;
  if (session.keyId) return key.key_id === session.keyId;
  return Boolean(key.key_prefix &&
    key.key_prefix === `${session.userKey.startsWith('sk-mem-') ? 'sk-mem-' : ''}****${session.userKey.slice(-4)}`);
}
