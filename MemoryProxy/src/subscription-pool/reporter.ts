/**
 * Reporter to Core: sends what the proxy saw for an account (quota windows, 429, 401, active
 * session count) to `subscription-pool/report`.
 *
 * It never blocks a response. Per account it sends at most one report every 5 s: the first goes
 * out at once, later ones are merged and sent when the interval ends. A window is reported only
 * when its usage moved by 1 % or more, or its reset time changed, since the last report.
 * Failures are logged with the account id only; a report that failed on the network or with a
 * server error is sent again at the next interval.
 */

import { callPoolCore, PoolCoreError, type PoolCoreConfig } from "./core-client.js";
import type { PoolQuotaWindow } from "./types.js";

const TAG = "[subscription-pool/reporter]";
export const REPORT_INTERVAL_MS = 5_000;
const MIN_CHANGE_PCT = 1;

export interface AccountReportPatch {
  status_code?: number;
  /** Seconds until the limit lifts (Core's `retry_after`). */
  retry_after?: number;
  active_sessions?: number;
  windows?: PoolQuotaWindow[];
}

interface Pending {
  status_code?: number;
  retry_after?: number;
  active_sessions?: number;
  windows: Map<string, PoolQuotaWindow>;
}

interface AccountState {
  lastSentAt: number;
  lastWindows: Map<string, { used_pct: number; resets_at: number | null }>;
  pending: Pending | null;
  timer: ReturnType<typeof setTimeout> | null;
  config: PoolCoreConfig;
  spaceId: string;
  accountId: string;
}

const states = new Map<string, AccountState>();

function windowKey(window: Pick<PoolQuotaWindow, "name" | "model_scope">): string {
  return `${window.name}\u0000${window.model_scope ?? ""}`;
}

function mergeInto(pending: Pending, patch: AccountReportPatch): void {
  // A 429 always wins within a batch: Core only acts on 429, so a later 401 must not hide it.
  const keepLimit = pending.status_code === 429 && patch.status_code !== undefined && patch.status_code !== 429;
  if (patch.status_code !== undefined && !keepLimit) {
    pending.status_code = patch.status_code;
    // A retry_after belongs to the status it came with.
    if (patch.retry_after !== undefined) pending.retry_after = patch.retry_after;
    else if (patch.status_code !== 429) delete pending.retry_after;
  }
  if (patch.active_sessions !== undefined) pending.active_sessions = patch.active_sessions;
  for (const window of patch.windows ?? []) pending.windows.set(windowKey(window), window);
}

/** Windows that moved enough to be worth sending. */
function changedWindows(state: AccountState, pending: Pending): PoolQuotaWindow[] {
  const out: PoolQuotaWindow[] = [];
  for (const [key, window] of pending.windows) {
    const last = state.lastWindows.get(key);
    if (!last || Math.abs(window.used_pct - last.used_pct) >= MIN_CHANGE_PCT || window.resets_at !== last.resets_at) {
      out.push(window);
    }
  }
  return out;
}

function send(state: AccountState): void {
  state.timer = null;
  const pending = state.pending;
  state.pending = null;
  if (!pending) return;

  const windows = changedWindows(state, pending);
  const hasOther = pending.status_code !== undefined || pending.active_sessions !== undefined;
  if (windows.length === 0 && !hasOther) return;

  const body: Record<string, unknown> = { account_id: state.accountId };
  if (pending.status_code !== undefined) body.status_code = pending.status_code;
  if (pending.retry_after !== undefined) body.retry_after = pending.retry_after;
  if (pending.active_sessions !== undefined) body.active_sessions = pending.active_sessions;
  if (windows.length > 0) body.windows = windows;

  state.lastSentAt = Date.now();
  callPoolCore(state.config, state.spaceId, "report", body).then(() => {
    // A reading counts as sent only once Core has it, so a failed one is not skipped as unchanged.
    for (const window of windows) {
      state.lastWindows.set(windowKey(window), { used_pct: window.used_pct, resets_at: window.resets_at });
    }
  }, (err: unknown) => {
    console.warn(`${TAG} report failed for account_id=${state.accountId}: ${err instanceof Error ? err.message : "unknown"}`);
    // A client error (for example a deleted account) will not succeed later; anything else is sent again.
    if (err instanceof PoolCoreError && err.httpStatus >= 400 && err.httpStatus < 500) return;
    requeue(state, { status_code: pending.status_code, retry_after: pending.retry_after, active_sessions: pending.active_sessions, windows });
  });
}

/** Put a failed report back in front of anything queued since, then send it at the next interval. */
function requeue(state: AccountState, failed: AccountReportPatch): void {
  const newer = state.pending;
  state.pending = { windows: new Map() };
  mergeInto(state.pending, failed);
  if (newer) {
    mergeInto(state.pending, { status_code: newer.status_code, retry_after: newer.retry_after, active_sessions: newer.active_sessions, windows: [...newer.windows.values()] });
  }
  schedule(state);
}

function schedule(state: AccountState): void {
  if (state.timer) return;
  const wait = Math.max(0, state.lastSentAt + REPORT_INTERVAL_MS - Date.now());
  state.timer = setTimeout(() => send(state), wait);
  state.timer.unref?.();
}

/** Queue a report for an account. Returns at once; never throws. */
export function reportAccount(config: PoolCoreConfig, spaceId: string, accountId: string, patch: AccountReportPatch): void {
  const key = `${spaceId}\u0000${accountId}`;
  let state = states.get(key);
  if (!state) {
    state = { lastSentAt: 0, lastWindows: new Map(), pending: null, timer: null, config, spaceId, accountId };
    states.set(key, state);
  }
  state.config = config;
  state.pending ??= { windows: new Map() };
  mergeInto(state.pending, patch);
  schedule(state);
}

/** Drop all state and timers (for testing). */
export function resetReporterForTests(): void {
  for (const state of states.values()) if (state.timer) clearTimeout(state.timer);
  states.clear();
}
