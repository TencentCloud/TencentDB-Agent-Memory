import { hashCanonical, immutableCopy } from "../core/canonical.js";

export const T1_PAID_WINDOW_AUTHORITY_BODY = {
  schemaVersion: "direction-a.evo-engineering-first-t1-paid-window-authority.v2",
  decisionId: "EVO_ENGINEERING_FIRST_BUDGET100_V1_2026_09_12",
  scope: "EVO_ENGINEERING_FIRST_T1",
  allowedDomains: ["d6", "d3"],
  allowedTargetRound: 5,
  expectedProviderCalls: 216,
  maximumProviderCalls: 264,
  stageHardCapCny: 36.4,
  globalNewSpendHardCapCny: 100,
  pricingMode: "DEEPSEEK_ANY_PRICING_WINDOW",
  ratesCnyPerMillionTokens: { cacheHitInput: 0.15, cacheMissInput: 4.5, output: 13.5 },
  wholeGroupReservationRequired: true,
  dockerReadinessBeforeSecretRead: true,
  reservationBeforeSecretRead: true,
  pair5Forbidden: true,
} as const;

export const T1_PAID_WINDOW_AUTHORITY = immutableCopy({ ...T1_PAID_WINDOW_AUTHORITY_BODY,
  contentHash: hashCanonical(T1_PAID_WINDOW_AUTHORITY_BODY) });

export function assertT1PaidExecutionWindow(now = new Date()): void {
  if (!Number.isFinite(now.getTime())) throw new Error("T1_PAID_EXECUTION_CLOCK_INVALID");
  const { contentHash, ...body } = T1_PAID_WINDOW_AUTHORITY;
  if (hashCanonical(body) !== contentHash || body.scope !== "EVO_ENGINEERING_FIRST_T1"
    || body.expectedProviderCalls !== 216 || body.maximumProviderCalls !== 264
    || body.stageHardCapCny !== 36.4 || body.globalNewSpendHardCapCny !== 100) throw new Error("T1_PAID_WINDOW_AUTHORITY_MISMATCH");
}

export function assertT1DoubleCap(input: { observedGlobalCny: number; unknownReserveCny: number; activeReservationsCny: number;
  stageCommittedCny: number; proposedGroupReservationCny: number; realizedProviderCalls: number; proposedProviderCalls: number }): void {
  const values = Object.values(input);
  if (values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("T1_BUDGET_STATE_INVALID");
  if (input.realizedProviderCalls + input.proposedProviderCalls > T1_PAID_WINDOW_AUTHORITY.maximumProviderCalls) throw new Error("T1_PROVIDER_CALL_CAP_EXCEEDED");
  if (input.stageCommittedCny + input.proposedGroupReservationCny > T1_PAID_WINDOW_AUTHORITY.stageHardCapCny + 1e-12) throw new Error("T1_STAGE_HARD_CAP_EXCEEDED");
  if (input.observedGlobalCny + input.unknownReserveCny + input.activeReservationsCny + input.proposedGroupReservationCny
    > T1_PAID_WINDOW_AUTHORITY.globalNewSpendHardCapCny + 1e-12) throw new Error("T1_GLOBAL_HARD_CAP_EXCEEDED");
}
