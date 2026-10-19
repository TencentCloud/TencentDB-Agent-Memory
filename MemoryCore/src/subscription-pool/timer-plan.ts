import type { SubscriptionAccountEntity } from "../metadata/types.js";

/** Refresh this long before the access token expires. */
export const REFRESH_LEAD_MS = 10 * 60 * 1000;
/** Check usage this long after a reset time, so the provider has applied the reset. */
export const RESET_CHECK_DELAY_MS = 30 * 1000;

export interface PlannedAccountTimer {
  kind: "refresh" | "reset-check";
  at: number;
}

/**
 * Timers that follow only from the stored account state. Retry timers are not planned here:
 * they follow a failure, and re-planning after every write must not move them.
 */
export function planAccountTimers(account: SubscriptionAccountEntity, thresholdPct: number, now: number): PlannedAccountTimer[] {
  if (!account.enabled || account.status === "disabled" || account.status === "auth_error") return [];
  const timers: PlannedAccountTimer[] = [];

  if (account.token_expires_at !== null && account.refresh_fail_count === 0) {
    timers.push({ kind: "refresh", at: Math.max(now, account.token_expires_at - REFRESH_LEAD_MS) });
  }

  let resetAt: number | null = account.exhausted_until;
  if (resetAt === null) {
    const resets = account.usage.windows
      .filter((window) => window.used_pct >= thresholdPct && window.resets_at !== null && window.resets_at > now)
      .map((window) => window.resets_at as number);
    resetAt = resets.length > 0 ? Math.min(...resets) : null;
  }
  if (resetAt !== null) timers.push({ kind: "reset-check", at: Math.max(now, resetAt + RESET_CHECK_DELAY_MS) });

  return timers;
}
