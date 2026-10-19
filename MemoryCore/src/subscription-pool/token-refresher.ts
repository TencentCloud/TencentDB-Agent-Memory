import type { IMetadataStore } from "../metadata/store/interface.js";
import {
  SubscriptionAccountWriteConflictError,
  type SubscriptionAccountEntity,
} from "../metadata/types.js";
import { SubscriptionProviderError, type SubscriptionProviderAdapter } from "./providers/types.js";

const locks = new Map<string, Promise<unknown>>();

/** Runs `fn` after every earlier call for the same account has finished. In-process only. */
export async function withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(accountId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  locks.set(accountId, tail);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(accountId) === tail) locks.delete(accountId);
  }
}

const RETRY_MINUTES = [1, 5, 15];

/** Delay before retry number `failCount` (1-based): 1, 5, then 15 minutes. */
export function nextRetryDelayMs(failCount: number): number {
  const index = Math.min(Math.max(failCount, 1), RETRY_MINUTES.length) - 1;
  return RETRY_MINUTES[index] * 60 * 1000;
}

export const REFRESH_FAILED = "refresh failed";
export const RELOGIN_NEEDED = "re-login needed";

export interface RefreshOptions {
  /** Refresh only when the token expires within this time. An unknown expiry is not refreshed. */
  ifExpiresWithinMs?: number;
  /**
   * Expiry of the token the caller holds (the proxy after a 401). When the stored token differs,
   * someone refreshed already and the stored token is returned without a provider call.
   */
  heldExpiresAt?: number | null;
}

export interface RefreshResult {
  account: SubscriptionAccountEntity;
  refreshed: boolean;
  /** The provider refused or could not be reached. */
  failed: boolean;
  /** Time of the next attempt after a transient failure. Null otherwise. */
  retryAt: number | null;
}

export async function refreshAccountTokens(
  store: IMetadataStore,
  accountId: string,
  adapter: SubscriptionProviderAdapter,
  options: RefreshOptions = {},
): Promise<RefreshResult> {
  return withAccountLock(accountId, async () => {
    const current = await store.getSubscriptionAccount(accountId);
    if (!current) throw new SubscriptionAccountWriteConflictError("account_not_found", `subscription account not found: ${accountId}`);

    if (options.heldExpiresAt !== undefined && current.token_expires_at !== options.heldExpiresAt) {
      return { account: current, refreshed: false, failed: false, retryAt: null };
    }
    if (options.ifExpiresWithinMs !== undefined
      && (current.token_expires_at === null || current.token_expires_at - Date.now() > options.ifExpiresWithinMs)) {
      return { account: current, refreshed: false, failed: false, retryAt: null };
    }

    let next;
    try {
      next = await adapter.refresh(current.refresh_token);
    } catch (error) {
      const permanent = error instanceof SubscriptionProviderError && error.permanent;
      const failCount = current.refresh_fail_count + 1;
      const saved = await store.updateSubscriptionAccount(accountId, {
        status: permanent ? "auth_error" : undefined,
        refresh_fail_count: permanent ? undefined : failCount,
        last_error: permanent ? RELOGIN_NEEDED : REFRESH_FAILED,
      });
      return { account: saved, refreshed: false, failed: true, retryAt: permanent ? null : Date.now() + nextRetryDelayMs(failCount) };
    }

    // No version check: only the lock holder writes tokens, and the provider has already
    // revoked the old refresh token, so this pair must be stored whatever else changed.
    // Every field of a refresh response is optional; a missing one keeps the stored value.
    const saved = await store.updateSubscriptionAccount(accountId, {
      access_token: next.accessToken || undefined,
      refresh_token: next.refreshToken || undefined,
      token_expires_at: next.accessToken ? next.expiresAt : undefined,
      account_label: next.accountLabel || undefined,
      status: current.status === "auth_error" ? "active" : undefined,
      refresh_fail_count: 0,
      last_error: current.last_error === REFRESH_FAILED || current.last_error === RELOGIN_NEEDED ? null : undefined,
    });
    return { account: saved, refreshed: true, failed: false, retryAt: null };
  });
}
