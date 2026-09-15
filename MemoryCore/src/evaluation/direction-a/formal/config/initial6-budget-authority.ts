import { hashCanonical, immutableCopy } from "../core/canonical.js";

export const INITIAL6_BUDGET_AUTHORITY_BODY = {
  schemaVersion: "direction-a.initial6-budget-researcher-authority.v3",
  decisionId: "INITIAL6-OFFPEAK-CNY100-SOFT-2026-09-06",
  decidedAt: "2026-09-06T02:55:06.0767384+08:00",
  approvedBy: "RESEARCHER",
  supersedesDecisionId: "INITIAL6-OFFPEAK-CNY100-2026-09-05",
  planningTargetCny: 100,
  monetaryLimitSemantics: "PLANNING_SOFT_TARGET_WITH_COMPLETE_GROUP_OVERSHOOT",
  atomicUnit: "CAUSAL_GROUP_COMPLETE_UNIT",
  atomicGroupOvershootAccepted: true,
  nextGroupStartRule: "RECONCILED_ACTUAL_PLUS_FROZEN_GROUP_PLANNING_RESERVATION_LTE_TARGET",
  maxPaidCallsRemainsHard: true,
  noCostDrivenResampling: true,
  pricingMode: "DEEPSEEK_OFF_PEAK_ONLY",
  providerTimeZone: "Asia/Shanghai",
  peakWeekdays: [1, 2, 3, 4, 5],
  peakWindowsLocal: ["09:00-12:00", "14:00-18:00"],
  ratesCnyPerMillionTokens: { cacheHitInput: 0.15, cacheMissInput: 4.5, output: 13.5 },
  modelProviderProfileUnchanged: true,
} as const;

export const INITIAL6_BUDGET_AUTHORITY = immutableCopy({
  ...INITIAL6_BUDGET_AUTHORITY_BODY,
  contentHash: hashCanonical(INITIAL6_BUDGET_AUTHORITY_BODY),
});

/** Researcher-authorized pricing-window amendment for the unfinished exact Initial-6 only. */
export const INITIAL6_PEAK_CONTINUATION_AUTHORITY_BODY = {
  schemaVersion: "direction-a.initial6-pricing-window-amendment.v1",
  decisionId: "INITIAL6-PEAK-CONTINUATION-2026-09-07",
  decidedAt: "2026-09-07T09:05:52.8549839+08:00",
  approvedBy: "RESEARCHER",
  supersedesPricingModeOfDecisionId: INITIAL6_BUDGET_AUTHORITY_BODY.decisionId,
  scope: "REMAINING_ALREADY_STARTED_EXACT_INITIAL6_ONLY",
  pricingMode: "DEEPSEEK_ANY_PRICING_WINDOW",
  planningTargetCny: 100,
  monetaryLimitSemantics: "PLANNING_SOFT_TARGET_WITH_COMPLETE_GROUP_OVERSHOOT",
  maxPaidCalls: 1392,
  noTaskExpansion: true,
  noDeepExpansion: true,
  modelProviderProfileUnchanged: true,
} as const;

export const INITIAL6_PEAK_CONTINUATION_AUTHORITY = immutableCopy({
  ...INITIAL6_PEAK_CONTINUATION_AUTHORITY_BODY,
  contentHash: hashCanonical(INITIAL6_PEAK_CONTINUATION_AUTHORITY_BODY),
});

export function assertInitial6BudgetAuthority(value: typeof INITIAL6_BUDGET_AUTHORITY): void {
  const { contentHash, ...body } = value;
  if (hashCanonical(body) !== contentHash || contentHash !== INITIAL6_BUDGET_AUTHORITY.contentHash) throw new Error("INITIAL6_BUDGET_AUTHORITY_MISMATCH");
}

export function isDeepSeekOffPeak(now: Date): boolean {
  if (!Number.isFinite(now.getTime())) throw new Error("OFF_PEAK_CLOCK_INVALID");
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const weekdayPeak = weekday >= 1 && weekday <= 5;
  const inPeakWindow = (minute >= 9 * 60 && minute < 12 * 60) || (minute >= 14 * 60 && minute < 18 * 60);
  return !(weekdayPeak && inPeakWindow);
}

export function assertDeepSeekOffPeak(now = new Date()): void {
  if (!isDeepSeekOffPeak(now)) throw new Error("PAID_EXECUTION_BLOCKED_PEAK_PRICING_WINDOW");
}

export function assertInitial6PaidExecutionWindow(now = new Date()): void {
  if (!Number.isFinite(now.getTime())) throw new Error("PAID_EXECUTION_CLOCK_INVALID");
  const { contentHash, ...body } = INITIAL6_PEAK_CONTINUATION_AUTHORITY;
  if (hashCanonical(body) !== contentHash
    || body.pricingMode !== "DEEPSEEK_ANY_PRICING_WINDOW"
    || body.scope !== "REMAINING_ALREADY_STARTED_EXACT_INITIAL6_ONLY"
    || body.maxPaidCalls !== 1392) {
    throw new Error("INITIAL6_PEAK_CONTINUATION_AUTHORITY_MISMATCH");
  }
}
