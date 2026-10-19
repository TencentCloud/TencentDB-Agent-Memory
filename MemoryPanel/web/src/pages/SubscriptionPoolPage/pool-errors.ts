/**
 * Maps a Core subscription-pool error to a localized message.
 * Core puts its error identifier at the start of the message, so the code comes from there.
 * Returns null for errors without a pool-specific message.
 */
import i18n from '@/i18n';
import { ApiError } from '@/lib/api/base';
import { parsePoolErrorCode } from '@/lib/subscription-pool-display';

export function poolErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  return parsePoolErrorCode(error.rawMessage);
}

export function poolErrorMessage(error: unknown): string | null {
  const code = poolErrorCode(error);
  if (!code) return null;
  const key = `subscriptionPool.error.${code}`;
  return i18n.exists(key) ? i18n.t(key) : null;
}
