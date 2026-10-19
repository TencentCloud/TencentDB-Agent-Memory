/**
 * Pure display logic of the Subscription Pool page.
 *
 * No imports, so the Panel Vitest (node environment) can run it. Functions return
 * discriminants and plain values; the components map them to translated text.
 * Every time-dependent function takes `now` (epoch ms) so results are deterministic.
 */

export type PoolProvider = 'claude' | 'codex';
export type PoolAccountStatus = 'active' | 'exhausted' | 'auth_error' | 'disabled';

/** One quota window as Core returns it. Times are epoch milliseconds. */
export interface PoolWindow {
  name: string;
  model_scope?: string | null;
  used_pct: number;
  resets_at: number | null;
  observed_at: number;
  source: string;
}

/** The account fields the display rules read. */
export interface PoolAccountLike {
  enabled: boolean;
  status: PoolAccountStatus;
  exhausted_until: number | null;
  usage_fail_count: number;
  usage: { windows: PoolWindow[] };
}

export type AccountState =
  | 'active'
  | 'ready_pool_off'
  | 'near_limit'
  | 'exhausted'
  | 'auth_error'
  | 'disabled';

export type MeterLevel = 'ok' | 'warn' | 'full';

/** Consecutive usage API failures before the page shows "Usage check failing". */
export const USAGE_FAIL_LIMIT = 3;

/** A meter turns to the warning color from this percent (or from the threshold when it is lower). */
const METER_WARN_PCT = 70;

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** A window whose reset time has passed shows as reset (0 %), not its stored percent. */
export function effectiveWindow(window: PoolWindow, now: number): { pct: number; reset: boolean } {
  if (window.resets_at !== null && window.resets_at <= now) return { pct: 0, reset: true };
  return { pct: clampPct(window.used_pct), reset: false };
}

function isSharedWindow(window: PoolWindow): boolean {
  return !window.model_scope;
}

export function usageCheckFailing(account: { usage_fail_count: number }): boolean {
  return account.usage_fail_count >= USAGE_FAIL_LIMIT;
}

/**
 * Status of one account row. Order of precedence: disabled, re-login needed, exhausted,
 * near limit, then active (or ready while the pool is off).
 * An account counts as exhausted only until `exhausted_until`; after that the proxy uses
 * it again even when the stored status still says exhausted.
 */
export function accountState(
  account: PoolAccountLike,
  opts: { now: number; threshold: number; poolEnabled: boolean },
): AccountState {
  if (!account.enabled || account.status === 'disabled') return 'disabled';
  if (account.status === 'auth_error') return 'auth_error';
  const until = account.exhausted_until;
  if (until !== null ? until > opts.now : account.status === 'exhausted') return 'exhausted';
  const nearLimit = account.usage.windows.some(
    (w) => isSharedWindow(w) && effectiveWindow(w, opts.now).pct >= opts.threshold,
  );
  if (nearLimit) return 'near_limit';
  return opts.poolEnabled ? 'active' : 'ready_pool_off';
}

export function meterLevel(pct: number, threshold: number): MeterLevel {
  if (pct >= 100) return 'full';
  if (pct >= Math.min(METER_WARN_PCT, threshold)) return 'warn';
  return 'ok';
}

/** Position of the threshold mark on a meter, in percent of the bar width. */
export function thresholdMark(threshold: number): number {
  return clampPct(threshold);
}

const PRIMARY_NAMES = new Set(['primary_window', 'five_hour']);
const SECONDARY_NAMES = new Set(['secondary_window', 'seven_day']);

/**
 * Splits windows into the two meter columns and the extra rows.
 * Per-model windows and shared windows with an unknown name become extra rows.
 */
export function groupWindows(windows: PoolWindow[]): {
  primary: PoolWindow | null;
  secondary: PoolWindow | null;
  extra: PoolWindow[];
} {
  let primary: PoolWindow | null = null;
  let secondary: PoolWindow | null = null;
  const extra: PoolWindow[] = [];
  for (const w of windows) {
    if (isSharedWindow(w) && !primary && PRIMARY_NAMES.has(w.name)) primary = w;
    else if (isSharedWindow(w) && !secondary && SECONDARY_NAMES.has(w.name)) secondary = w;
    else extra.push(w);
  }
  return { primary, secondary, extra };
}

export interface TimeFormatOptions {
  /** IANA time zone. Defaults to the browser time zone. */
  timeZone?: string;
  locale?: string;
}

function dayKey(ms: number, fmt: TimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: fmt.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}

/** "15:10" for a time on the same day as `now`, "Thu 08:30" for another day. */
export function formatResetAt(resetsAt: number, now: number, fmt: TimeFormatOptions = {}): string {
  const clock = new Intl.DateTimeFormat(fmt.locale, {
    timeZone: fmt.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(resetsAt);
  if (dayKey(resetsAt, fmt) === dayKey(now, fmt)) return clock;
  const weekday = new Intl.DateTimeFormat(fmt.locale, { timeZone: fmt.timeZone, weekday: 'short' }).format(resetsAt);
  return `${weekday} ${clock}`;
}

/** "2d 21h", "3h 40m", "36m". Days drop a zero hour part. */
export function formatRemaining(resetsAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((resetsAt - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export interface WindowView {
  pct: number;
  level: MeterLevel;
  /** True when the stored reset time has passed. */
  reset: boolean;
  /** Reset time in local time. Null when the window has reset or the provider gave no time. */
  resetAt: string | null;
  /** Time left until the reset. Null when `resetAt` is null. */
  remaining: string | null;
}

export function describeWindow(
  window: PoolWindow,
  now: number,
  threshold: number,
  fmt: TimeFormatOptions = {},
): WindowView {
  const { pct, reset } = effectiveWindow(window, now);
  const upcoming = !reset && window.resets_at !== null;
  return {
    pct,
    level: meterLevel(pct, threshold),
    reset,
    resetAt: upcoming ? formatResetAt(window.resets_at as number, now, fmt) : null,
    remaining: upcoming ? formatRemaining(window.resets_at as number, now) : null,
  };
}

/** Time of the newest observation across windows, with where it came from. */
export function latestObservation(windows: PoolWindow[]): { source: string; observedAt: number } | null {
  let best: PoolWindow | null = null;
  for (const w of windows) if (!best || w.observed_at > best.observed_at) best = w;
  return best ? { source: best.source, observedAt: best.observed_at } : null;
}

/** "HH:mm" in local time. */
export function formatClock(ms: number, fmt: TimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat(fmt.locale, {
    timeZone: fmt.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(ms);
}

/**
 * Core puts its error identifier at the start of the message ("POOL_NOT_ENABLED: ...").
 * The envelope code is only the HTTP status, so callers branch on this value.
 */
export function parsePoolErrorCode(message: string | undefined | null): string | null {
  const match = /^([A-Za-z][A-Za-z0-9_]*):/.exec(message ?? '');
  return match ? (match[1] as string) : null;
}

/** Body fields for the login completion call: a pasted URL or a bare code. Null when empty. */
export function oauthCompleteInput(raw: string): { redirect_url: string } | { code: string } | null {
  const value = raw.trim();
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? { redirect_url: value } : { code: value };
}
