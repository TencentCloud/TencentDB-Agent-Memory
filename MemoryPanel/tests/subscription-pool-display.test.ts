import { describe, expect, it } from 'vitest';
import {
  USAGE_FAIL_LIMIT,
  accountState,
  describeWindow,
  effectiveWindow,
  groupWindows,
  meterLevel,
  oauthCompleteInput,
  parsePoolErrorCode,
  thresholdMark,
  usageCheckFailing,
  type PoolAccountLike,
  type PoolWindow,
} from '../web/src/lib/subscription-pool-display';

// 2026-10-19 11:30:00 in Asia/Saigon (UTC+7) = 04:30:00 UTC
const NOW = Date.UTC(2026, 9, 19, 4, 30, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const FMT = { timeZone: 'Asia/Saigon', locale: 'en-US' };

function win(over: Partial<PoolWindow> = {}): PoolWindow {
  return {
    name: 'primary_window',
    model_scope: null,
    used_pct: 40,
    resets_at: NOW + HOUR,
    observed_at: NOW - MIN,
    source: 'usage_api',
    ...over,
  };
}

function account(over: Partial<PoolAccountLike> = {}): PoolAccountLike {
  return {
    enabled: true,
    status: 'active',
    exhausted_until: null,
    usage_fail_count: 0,
    usage: { windows: [win(), win({ name: 'secondary_window', used_pct: 20 })] },
    ...over,
  };
}

describe('effectiveWindow', () => {
  it('returns the stored percent while the window has not reset', () => {
    expect(effectiveWindow(win({ used_pct: 42 }), NOW)).toEqual({ pct: 42, reset: false });
  });

  it('shows 0 percent and reset when resets_at has passed', () => {
    expect(effectiveWindow(win({ used_pct: 97, resets_at: NOW - 1 }), NOW)).toEqual({ pct: 0, reset: true });
  });

  it('treats resets_at equal to now as reset', () => {
    expect(effectiveWindow(win({ used_pct: 97, resets_at: NOW }), NOW)).toEqual({ pct: 0, reset: true });
  });

  it('keeps the stored percent when the reset time is unknown', () => {
    expect(effectiveWindow(win({ used_pct: 55, resets_at: null }), NOW)).toEqual({ pct: 55, reset: false });
  });

  it('clamps out-of-range percents to 0-100', () => {
    expect(effectiveWindow(win({ used_pct: 130 }), NOW).pct).toBe(100);
    expect(effectiveWindow(win({ used_pct: -5 }), NOW).pct).toBe(0);
    expect(effectiveWindow(win({ used_pct: Number.NaN }), NOW).pct).toBe(0);
  });
});

describe('accountState', () => {
  const base = { now: NOW, threshold: 95, poolEnabled: true };

  it('is active below the threshold', () => {
    expect(accountState(account(), base)).toBe('active');
  });

  it('is ready_pool_off for an active account when the pool is off', () => {
    expect(accountState(account(), { ...base, poolEnabled: false })).toBe('ready_pool_off');
  });

  it('is near_limit when a shared window is at or above the threshold', () => {
    const a = account({ usage: { windows: [win({ used_pct: 95 })] } });
    expect(accountState(a, base)).toBe('near_limit');
    expect(accountState(a, { ...base, poolEnabled: false })).toBe('near_limit');
  });

  it('ignores a window that has already reset when checking the threshold', () => {
    const a = account({ usage: { windows: [win({ used_pct: 99, resets_at: NOW - HOUR })] } });
    expect(accountState(a, base)).toBe('active');
  });

  it('ignores per-model windows for near_limit', () => {
    const a = account({ usage: { windows: [win({ name: 'opus_weekly', model_scope: 'opus', used_pct: 100 })] } });
    expect(accountState(a, base)).toBe('active');
  });

  it('is exhausted while exhausted_until is in the future', () => {
    const a = account({ status: 'exhausted', exhausted_until: NOW + HOUR });
    expect(accountState(a, base)).toBe('exhausted');
  });

  it('is exhausted when the status is exhausted and no release time is known', () => {
    expect(accountState(account({ status: 'exhausted', exhausted_until: null }), base)).toBe('exhausted');
  });

  it('is usable again once exhausted_until has passed even if the status is stale', () => {
    const a = account({ status: 'exhausted', exhausted_until: NOW - 1 });
    expect(accountState(a, base)).toBe('active');
  });

  it('is auth_error for a rejected login', () => {
    expect(accountState(account({ status: 'auth_error' }), base)).toBe('auth_error');
  });

  it('is disabled when the admin switch is off or the status is disabled', () => {
    expect(accountState(account({ enabled: false }), base)).toBe('disabled');
    expect(accountState(account({ status: 'disabled' }), base)).toBe('disabled');
  });

  it('ranks disabled above auth_error above exhausted above near_limit', () => {
    const windows = [win({ used_pct: 99 })];
    const exhausted = { status: 'exhausted' as const, exhausted_until: NOW + HOUR, usage: { windows } };
    expect(accountState(account({ ...exhausted, status: 'auth_error' }), base)).toBe('auth_error');
    expect(accountState(account({ ...exhausted, enabled: false, status: 'auth_error' }), base)).toBe('disabled');
    expect(accountState(account(exhausted), base)).toBe('exhausted');
  });
});

describe('usageCheckFailing', () => {
  it('turns on at the failure limit', () => {
    expect(USAGE_FAIL_LIMIT).toBe(3);
    expect(usageCheckFailing({ usage_fail_count: 2 })).toBe(false);
    expect(usageCheckFailing({ usage_fail_count: 3 })).toBe(true);
    expect(usageCheckFailing({ usage_fail_count: 9 })).toBe(true);
  });
});

describe('meterLevel and thresholdMark', () => {
  it('maps percent to ok / warn / full', () => {
    expect(meterLevel(42, 95)).toBe('ok');
    expect(meterLevel(61, 95)).toBe('ok');
    expect(meterLevel(77, 95)).toBe('warn');
    expect(meterLevel(96, 95)).toBe('warn');
    expect(meterLevel(100, 95)).toBe('full');
  });

  it('starts warning at the threshold when the threshold is low', () => {
    expect(meterLevel(55, 50)).toBe('warn');
    expect(meterLevel(49, 50)).toBe('ok');
  });

  it('places the threshold mark within the bar', () => {
    expect(thresholdMark(95)).toBe(95);
    expect(thresholdMark(120)).toBe(100);
    expect(thresholdMark(-3)).toBe(0);
  });
});

describe('groupWindows', () => {
  it('splits shared primary and secondary windows from per-model rows', () => {
    const opus = win({ name: 'opus_weekly', model_scope: 'opus' });
    const secondary = win({ name: 'secondary_window' });
    const primary = win({ name: 'primary_window' });
    const g = groupWindows([opus, secondary, primary]);
    expect(g.primary).toBe(primary);
    expect(g.secondary).toBe(secondary);
    expect(g.extra).toEqual([opus]);
  });

  it('keeps unknown shared windows as extra rows', () => {
    const odd = win({ name: 'monthly' });
    expect(groupWindows([odd]).extra).toEqual([odd]);
  });

  it('returns empty slots when there are no windows', () => {
    expect(groupWindows([])).toEqual({ primary: null, secondary: null, extra: [] });
  });
});

describe('describeWindow', () => {
  it('formats a same-day reset as a clock time with the time left (Asia/Saigon)', () => {
    // 11:30 now, reset in 3h40m = 15:10
    const d = describeWindow(win({ used_pct: 42, resets_at: NOW + 3 * HOUR + 40 * MIN }), NOW, 95, FMT);
    expect(d).toMatchObject({ pct: 42, level: 'ok', reset: false, resetAt: '15:10', remaining: '3h 40m' });
  });

  it('adds the weekday for a reset on another day', () => {
    // 2026-10-19 is a Monday; +2d 21h -> Thursday 08:30
    const d = describeWindow(win({ used_pct: 61, resets_at: NOW + 2 * DAY + 21 * HOUR }), NOW, 95, FMT);
    expect(d.resetAt).toBe('Thu 08:30');
    expect(d.remaining).toBe('2d 21h');
  });

  it('uses minutes only under one hour', () => {
    const d = describeWindow(win({ resets_at: NOW + 36 * MIN }), NOW, 95, FMT);
    expect(d.remaining).toBe('36m');
  });

  it('drops the hour part when it is zero', () => {
    const d = describeWindow(win({ resets_at: NOW + 2 * DAY }), NOW, 95, FMT);
    expect(d.remaining).toBe('2d');
  });

  it('shows 0 percent and the reset flag after the reset time', () => {
    const d = describeWindow(win({ used_pct: 99, resets_at: NOW - HOUR }), NOW, 95, FMT);
    expect(d).toMatchObject({ pct: 0, level: 'ok', reset: true, resetAt: null, remaining: null });
  });

  it('has no reset text when the provider gave no reset time', () => {
    const d = describeWindow(win({ resets_at: null }), NOW, 95, FMT);
    expect(d).toMatchObject({ reset: false, resetAt: null, remaining: null });
  });
});

describe('parsePoolErrorCode', () => {
  it('reads the leading code of a Core error message', () => {
    expect(parsePoolErrorCode('POOL_NOT_ENABLED: pool group does not exist')).toBe('POOL_NOT_ENABLED');
    expect(parsePoolErrorCode('account_not_found: nope')).toBe('account_not_found');
  });

  it('returns null when the message has no code prefix', () => {
    expect(parsePoolErrorCode('Request failed')).toBeNull();
    expect(parsePoolErrorCode(undefined)).toBeNull();
  });
});

describe('oauthCompleteInput', () => {
  it('sends a pasted URL as redirect_url', () => {
    const url = 'http://localhost:1455/auth/callback?code=abc&state=xyz';
    expect(oauthCompleteInput(`  ${url}\n`)).toEqual({ redirect_url: url });
  });

  it('sends anything else as code', () => {
    expect(oauthCompleteInput(' abc123 ')).toEqual({ code: 'abc123' });
  });

  it('returns null for empty input', () => {
    expect(oauthCompleteInput('   ')).toBeNull();
  });
});
