import type { IMetadataStore } from "../metadata/store/interface.js";
import {
  SubscriptionAccountWriteConflictError,
  type SubscriptionAccountEntity,
  type SubscriptionQuotaWindow,
  type UpdateSubscriptionAccountPatch,
} from "../metadata/types.js";
import type { SubscriptionProviderAdapter } from "./providers/types.js";
import { mergeUsageWindows } from "./quota-merge.js";
import { withAccountLock } from "./token-refresher.js";

export const USAGE_CHECK_FAILED = "usage check failed";
/** Next check for a window at the threshold whose reset time is unknown or already past. */
export const RECHECK_MS = 15 * 60 * 1000;

export interface UsageCheckResult {
  account: SubscriptionAccountEntity;
  failed: boolean;
}

/** A window that is still at the limit after its reset time is checked again in 15 minutes. */
function withNextCheck(windows: SubscriptionQuotaWindow[], thresholdPct: number, now: number): SubscriptionQuotaWindow[] {
  return windows.map((window) => (
    window.used_pct >= thresholdPct && (window.resets_at === null || window.resets_at <= now)
      ? { ...window, resets_at: now + RECHECK_MS }
      : window
  ));
}

/**
 * Reads usage from the provider and stores it. An exhausted account is released when every
 * shared window is below the threshold; otherwise it stays exhausted until the earliest reset of
 * a window at the threshold. When the provider call fails after the reset time, the account is
 * released by time.
 */
export async function checkAccountUsage(
  store: IMetadataStore,
  accountId: string,
  adapter: SubscriptionProviderAdapter,
  thresholdPct: number,
  now = Date.now(),
): Promise<UsageCheckResult> {
  const before = await store.getSubscriptionAccount(accountId);
  if (!before) throw new SubscriptionAccountWriteConflictError("account_not_found", `subscription account not found: ${accountId}`);

  let reading: SubscriptionQuotaWindow[] | null = null;
  try {
    reading = withNextCheck(await adapter.fetchUsage(before.access_token, before.provider_account_id), thresholdPct, now);
  } catch {
    reading = null;
  }

  return withAccountLock(accountId, async () => {
    const current = await store.getSubscriptionAccount(accountId);
    if (!current) throw new SubscriptionAccountWriteConflictError("account_not_found", `subscription account not found: ${accountId}`);
    const exhausted = current.status === "exhausted" || current.exhausted_until !== null;

    if (reading === null) {
      const patch: UpdateSubscriptionAccountPatch = { usage_fail_count: current.usage_fail_count + 1, last_error: USAGE_CHECK_FAILED };
      if (exhausted && (current.exhausted_until === null || current.exhausted_until <= now)) {
        patch.exhausted_until = null;
        if (current.status === "exhausted") patch.status = "active";
      }
      return { account: await store.updateSubscriptionAccount(accountId, patch), failed: true };
    }

    // A stored window that this reading did not return and whose reset has passed is stale: it
    // would hold the account at its old limit with a reset time that never comes again.
    const fresh = new Set(reading.map((window) => `${window.name}\0${window.model_scope ?? ""}`));
    const windows = mergeUsageWindows(current.usage.windows, reading).filter((window) => (
      fresh.has(`${window.name}\0${window.model_scope ?? ""}`) || window.resets_at === null || window.resets_at > now
    ));
    const patch: UpdateSubscriptionAccountPatch = {
      usage: { windows },
      usage_updated_at: now,
      usage_fail_count: 0,
      last_error: current.last_error === USAGE_CHECK_FAILED ? null : undefined,
    };
    if (exhausted) {
      const limitedResets = windows
        .filter((window) => (window.model_scope ?? null) === null && window.used_pct >= thresholdPct)
        .map((window) => (window.resets_at !== null && window.resets_at > now ? window.resets_at : now + RECHECK_MS));
      if (limitedResets.length === 0) {
        patch.exhausted_until = null;
        if (current.status === "exhausted") patch.status = "active";
      } else {
        patch.exhausted_until = Math.min(...limitedResets);
      }
    }
    return { account: await store.updateSubscriptionAccount(accountId, patch), failed: false };
  });
}
