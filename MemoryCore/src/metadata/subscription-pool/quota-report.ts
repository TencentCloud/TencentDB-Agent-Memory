import { mergeUsageWindows } from "../../subscription-pool/quota-merge.js";
import type { SubscriptionAccountStatus, SubscriptionAccountUsage, SubscriptionQuotaWindow } from "../types.js";

export const QUOTA_429_FALLBACK_MS = 15 * 60 * 1000;

export interface SubscriptionQuotaReport {
  windows?: SubscriptionQuotaWindow[];
  status_code?: number;
  retry_after?: number;
  active_sessions?: number;
}

export function applyQuotaReport(
  current: { status: SubscriptionAccountStatus; usage: SubscriptionAccountUsage; exhausted_until: number | null },
  report: SubscriptionQuotaReport,
  now: number,
): {
  status?: SubscriptionAccountStatus;
  usage?: SubscriptionAccountUsage;
  usage_updated_at?: number;
  exhausted_until?: number | null;
  active_sessions?: number;
} {
  const is429 = report.status_code === 429;
  let windows = report.windows ? mergeUsageWindows(current.usage.windows, report.windows) : current.usage.windows;
  const usageChanged = is429 || Boolean(report.windows);
  let exhausted_until = current.exhausted_until;
  if (is429) {
    if (report.retry_after !== undefined) {
      exhausted_until = now + report.retry_after * 1000;
    } else {
      const resets = windows.map((window) => window.resets_at).filter((value): value is number => value !== null && value > now);
      exhausted_until = resets.length > 0 ? Math.min(...resets) : now + QUOTA_429_FALLBACK_MS;
    }
    // A window held at 100 % must not outlive the exhaustion, or the reset check could not release it.
    const until = exhausted_until;
    windows = windows.map((window) => ({
      ...window,
      used_pct: 100,
      observed_at: now,
      source: "429",
      resets_at: window.resets_at === null || window.resets_at > until ? until : window.resets_at,
    }));
  }
  // Only a 429 changes status and exhaustion, so a report never undoes a Panel change, and an
  // account that needs a new login or was switched off keeps that status.
  const servable = current.status === "active" || current.status === "exhausted";
  return {
    status: is429 && servable ? "exhausted" : undefined,
    usage: usageChanged ? { windows } : undefined,
    usage_updated_at: usageChanged ? now : undefined,
    exhausted_until: is429 ? exhausted_until : undefined,
    active_sessions: report.active_sessions,
  };
}
