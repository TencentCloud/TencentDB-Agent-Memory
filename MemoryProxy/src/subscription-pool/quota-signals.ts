/**
 * Parse the quota signals of the Codex (ChatGPT) backend: rate-limit response headers and the
 * body of a 429. Provider times are epoch seconds; the pool works in epoch milliseconds.
 * Window names match the usage API names so Core can merge a header reading with a usage reading.
 */

import type { PoolQuotaWindow } from "./types.js";

/** Header prefixes of the two windows. The doubled "primary" in the secondary names is real. */
const WINDOW_HEADERS = [
  { name: "primary_window", used: "x-codex-primary-used-percent", reset: "x-codex-primary-reset-at" },
  { name: "secondary_window", used: "x-codex-secondary-primary-used-percent", reset: "x-codex-secondary-primary-reset-at" },
] as const;

function finiteNumber(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function parseCodexQuotaHeaders(headers: Headers, now: number): PoolQuotaWindow[] {
  const windows: PoolQuotaWindow[] = [];
  for (const spec of WINDOW_HEADERS) {
    const used = finiteNumber(headers.get(spec.used));
    if (used === null) continue;
    const resetSec = finiteNumber(headers.get(spec.reset));
    windows.push({
      name: spec.name,
      model_scope: null,
      used_pct: Math.min(100, Math.max(0, used)),
      resets_at: resetSec === null ? null : resetSec * 1000,
      observed_at: now,
      source: "header",
    });
  }
  return windows;
}

export interface CodexLimitInfo {
  /** Epoch milliseconds when the limit lifts, or null when the response does not say. */
  resetsAt: number | null;
  /** Seconds until then, as Core's `retry_after`. */
  retryAfterSec: number | null;
}

/**
 * Reset time of a 429. Sources, first match wins: `error.resets_at` (epoch s), then
 * `error.resets_in_seconds`, then the `retry-after` header (seconds).
 */
export function parseCodexLimitBody(bodyText: string, headers: Headers, now: number): CodexLimitInfo {
  let resetsAt: number | null = null;
  try {
    const parsed = JSON.parse(bodyText) as { error?: { resets_at?: unknown; resets_in_seconds?: unknown } };
    const error = parsed?.error;
    if (typeof error?.resets_at === "number" && Number.isFinite(error.resets_at)) {
      resetsAt = error.resets_at * 1000;
    } else if (typeof error?.resets_in_seconds === "number" && Number.isFinite(error.resets_in_seconds)) {
      resetsAt = now + error.resets_in_seconds * 1000;
    }
  } catch {
    // A body that is not JSON carries no reset time.
  }
  if (resetsAt === null) {
    const header = finiteNumber(headers.get("retry-after"));
    if (header !== null) resetsAt = now + header * 1000;
  }
  if (resetsAt === null || resetsAt <= now) return { resetsAt: null, retryAfterSec: null };
  return { resetsAt, retryAfterSec: Math.ceil((resetsAt - now) / 1000) };
}

/** Claude rate-limit headers. Utilization is a fraction (about 0 to 1); the pool stores a percent. */
const CLAUDE_WINDOW_HEADERS = [
  { name: "five_hour", used: "anthropic-ratelimit-unified-5h-utilization", reset: "anthropic-ratelimit-unified-5h-reset" },
  { name: "seven_day", used: "anthropic-ratelimit-unified-7d-utilization", reset: "anthropic-ratelimit-unified-7d-reset" },
] as const;

export function parseClaudeQuotaHeaders(headers: Headers, now: number): PoolQuotaWindow[] {
  const windows: PoolQuotaWindow[] = [];
  for (const spec of CLAUDE_WINDOW_HEADERS) {
    const fraction = finiteNumber(headers.get(spec.used));
    if (fraction === null) continue;
    const resetSec = finiteNumber(headers.get(spec.reset));
    windows.push({
      name: spec.name,
      model_scope: null,
      used_pct: Math.min(100, Math.max(0, fraction * 100)),
      resets_at: resetSec === null ? null : resetSec * 1000,
      observed_at: now,
      source: "header",
    });
  }
  return windows;
}

/**
 * Reset time of a Claude 429. Sources, first match wins: the unified reset header (epoch s),
 * the 5-hour window reset, then `retry-after` (seconds).
 */
export function parseClaudeLimitBody(headers: Headers, now: number): CodexLimitInfo {
  const unified = finiteNumber(headers.get("anthropic-ratelimit-unified-reset"));
  const fiveHour = finiteNumber(headers.get("anthropic-ratelimit-unified-5h-reset"));
  const retryAfter = finiteNumber(headers.get("retry-after"));
  const resetsAt = unified !== null
    ? unified * 1000
    : fiveHour !== null
      ? fiveHour * 1000
      : retryAfter !== null
        ? now + retryAfter * 1000
        : null;
  if (resetsAt === null || resetsAt <= now) return { resetsAt: null, retryAfterSec: null };
  return { resetsAt, retryAfterSec: Math.ceil((resetsAt - now) / 1000) };
}
