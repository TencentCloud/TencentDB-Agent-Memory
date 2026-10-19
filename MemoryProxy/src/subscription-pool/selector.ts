/**
 * Pure account selection for the subscription pool. No I/O and no clock: the caller passes `now`.
 *
 * Order of preference:
 *   1. the account the session is bound to, until that account reaches its quota (the threshold
 *      only stops new sessions, so a bound session stays above it);
 *   2. the next eligible account by round-robin from the cursor;
 *   3. the not-exhausted account with the lowest usage, even above the threshold;
 *   4. nothing (`null`), and the caller falls back to the client's own login or a 429.
 */

import type { PoolAccount, PoolQuotaWindow } from "./types.js";

/** A window at this usage has no quota left. */
const QUOTA_REACHED_PCT = 100;

export type SelectionKind = "bound" | "round_robin" | "lowest_usage";

export interface Selection {
  account: PoolAccount;
  kind: SelectionKind;
  /** Cursor value to store after a round-robin pick. Unchanged for the other kinds. */
  nextCursor: number;
}

/** A window whose reset time has passed counts as reset, whatever percentage was stored. */
function windowUsage(window: PoolQuotaWindow, now: number): number {
  if (window.resets_at !== null && window.resets_at <= now) return 0;
  return window.used_pct;
}

/** Windows that limit a request for `requestedModel`: the shared ones and the model's own. */
function applicableWindows(account: PoolAccount, requestedModel: string): PoolQuotaWindow[] {
  return account.usage.windows.filter((window) => {
    const scope = window.model_scope;
    return scope === null || scope === undefined || scope === requestedModel;
  });
}

/** Highest usage over the windows that apply to the request. 0 when the account has no window. */
export function accountUsagePct(account: PoolAccount, now: number, requestedModel: string): number {
  let max = 0;
  for (const window of applicableWindows(account, requestedModel)) {
    max = Math.max(max, windowUsage(window, now));
  }
  return max;
}

/** True while the account must not receive requests because of a 429 or a quota stop. */
export function isExhausted(account: PoolAccount, now: number): boolean {
  if (account.exhausted_until !== null) return now < account.exhausted_until;
  return account.status === "exhausted";
}

/**
 * Enabled, in a servable state, and not exhausted. An account that Core still marks `exhausted`
 * after its `exhausted_until` has passed is released here, even when a Core timer was missed.
 */
function isServable(account: PoolAccount, now: number): boolean {
  if (!account.enabled) return false;
  if (account.status !== "active" && account.status !== "exhausted") return false;
  return !isExhausted(account, now);
}

function isEligible(account: PoolAccount, now: number, thresholdPct: number, requestedModel: string): boolean {
  return isServable(account, now) && accountUsagePct(account, now, requestedModel) < thresholdPct;
}

export function selectAccount(
  accounts: readonly PoolAccount[],
  binding: string | null,
  now: number,
  thresholdPct: number,
  requestedModel: string,
  cursor = 0,
  excluded: ReadonlySet<string> = new Set(),
): Selection | null {
  const candidates = accounts
    .filter((account) => !excluded.has(account.account_id))
    .sort((a, b) => (a.account_id < b.account_id ? -1 : a.account_id > b.account_id ? 1 : 0));
  if (candidates.length === 0) return null;

  if (binding !== null) {
    const bound = candidates.find((account) => account.account_id === binding);
    if (bound && isServable(bound, now) && accountUsagePct(bound, now, requestedModel) < QUOTA_REACHED_PCT) {
      return { account: bound, kind: "bound", nextCursor: cursor };
    }
  }

  const start = ((cursor % candidates.length) + candidates.length) % candidates.length;
  for (let step = 0; step < candidates.length; step++) {
    const index = (start + step) % candidates.length;
    const account = candidates[index]!;
    if (isEligible(account, now, thresholdPct, requestedModel)) {
      return { account, kind: "round_robin", nextCursor: (index + 1) % candidates.length };
    }
  }

  let lowest: PoolAccount | null = null;
  let lowestPct = Infinity;
  for (let step = 0; step < candidates.length; step++) {
    const account = candidates[(start + step) % candidates.length]!;
    if (!isServable(account, now)) continue;
    const pct = accountUsagePct(account, now, requestedModel);
    if (pct < lowestPct) {
      lowest = account;
      lowestPct = pct;
    }
  }
  return lowest ? { account: lowest, kind: "lowest_usage", nextCursor: cursor } : null;
}

/**
 * Earliest moment an account of the pool may serve again, in epoch milliseconds, or null when
 * no account has a known reset (all disabled or needing a new login, or no reset time reported).
 */
export function earliestReset(
  accounts: readonly PoolAccount[],
  now: number,
  thresholdPct: number,
  requestedModel: string,
): number | null {
  let earliest: number | null = null;
  const consider = (at: number | null): void => {
    if (at === null || at <= now) return;
    if (earliest === null || at < earliest) earliest = at;
  };
  for (const account of accounts) {
    if (!account.enabled || (account.status !== "active" && account.status !== "exhausted")) continue;
    if (account.exhausted_until !== null && now < account.exhausted_until) {
      consider(account.exhausted_until);
      continue;
    }
    for (const window of applicableWindows(account, requestedModel)) {
      if (windowUsage(window, now) >= thresholdPct) consider(window.resets_at);
    }
  }
  return earliest;
}
