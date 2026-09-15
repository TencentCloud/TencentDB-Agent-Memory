import { hashCanonical, immutableCopy } from "../core/canonical.js";

/**
 * Fresh budget authority for the mechanically frozen active prefix of the frozen N9 task order.
 *
 * researcher decision (2026-09-14, final fast path):
 *   - Fresh CNY100 already spent = 10.022517 (all of it stays charged to this cap).
 *   - The budget is TELEMETRY ONLY.  reservation / rolling reserve / projected spend may never
 *     fail-close an in-flight run.  Only a genuine provider refusal (balance/quota) stops execution.
 *   - The active prefix5 sample, its order, and its task count are unchanged; task 6 stays forbidden.
 *
 * Mechanical prefix freeze, derived before any Fresh paid observation:
 *   frozen N9 off-peak protected reservation = 89.4085065 ; peak multiplier = 2
 *   N9 peak-equivalent = 178.817013 ; per complete task = 178.817013 / 9 = 19.868557
 *   => 4 tasks = 79.474228 | 5 tasks = 99.342785 | 6 tasks = 119.211342
 *   6 tasks exceeds the CNY100 cap, therefore the active prefix is 5.
 */
export const FRESH_ACTIVE_PREFIX_N = 5 as const;
export const FRESH_FROZEN_N9_PREFIX_LENGTH = 9 as const;
export const FRESH_N9_OFFPEAK_PROTECTED_RESERVATION_CNY = 89.4085065 as const;
export const FRESH_PEAK_MULTIPLIER = 2 as const;
export const FRESH_N9_PEAK_EQUIVALENT_RESERVATION_CNY = 178.817013 as const;
export const FRESH_PER_COMPLETE_TASK_PEAK_RESERVE_CNY = 19.868557 as const;
export const FRESH_ACTIVE_PREFIX_N_PEAK_RESERVE_LADDER_CNY = { 4: 79.474228, 5: 99.342785, 6: 119.211342 } as const;

export const FRESH_MAX_TURNS_PER_TRIAL = 12 as const;
export const FRESH_NORMAL_ATTEMPTS_PER_TASK = 1 as const;
export const FRESH_CAUSAL_ATTEMPTS_PER_TASK = 8 as const;
export const FRESH_BASE_ATTEMPTS_PER_TASK = FRESH_NORMAL_ATTEMPTS_PER_TASK + FRESH_CAUSAL_ATTEMPTS_PER_TASK;
export const FRESH_TECHNICAL_REPLACEMENT_LIMIT_PER_TASK = 2 as const;
export const FRESH_MAX_ATTEMPTS_PER_TASK = FRESH_BASE_ATTEMPTS_PER_TASK + FRESH_TECHNICAL_REPLACEMENT_LIMIT_PER_TASK;

/** 5 complete tasks x (1 NORMAL + 8 causal) attempts x 12 turns. */
export const FRESH_EXPECTED_CALLS = 540 as const;
/** 5 complete tasks x (9 base + 2 technical replacement) attempts x 12 turns. */
export const FRESH_MAX_CALLS = 660 as const;
/**
 * Reporting-only conservative reserve for one complete frozen task.  It is never an
 * up-front prefix reservation and never an execution gate.
 */
export const FRESH_CONSERVATIVE_WHOLE_TASK_RESERVE_CNY = FRESH_PER_COMPLETE_TASK_PEAK_RESERVE_CNY;
export const FRESH_ROLLING_WHOLE_TASK_RESERVE_CNY = FRESH_CONSERVATIVE_WHOLE_TASK_RESERVE_CNY;
export const FRESH_PEAK_PROTECTED_RESERVATION_CNY = FRESH_ROLLING_WHOLE_TASK_RESERVE_CNY;
export const FRESH_P95_RESERVATION_CNY = FRESH_ROLLING_WHOLE_TASK_RESERVE_CNY;
/** Fresh spend that already happened before the new grant; every cent remains charged to the CNY100. */
export const FRESH_HISTORICAL_FRESH_SPEND_CNY = 10.022517 as const;
export const FRESH_REMAINING_FRESH_BUDGET_CNY = 89.977483 as const;
/**
 * Opening balance of the Fresh append-only ledger.  It is 0 on purpose: the ledger itself
 * already contains the CNY10.022517 of history, so charging it again as "prior" would
 * double count.  Declared history lives in FRESH_HISTORICAL_FRESH_SPEND_CNY.
 */
export const FRESH_LEDGER_OPENING_PRIOR_SPEND_CNY = 0 as const;
/** Legacy field name retained for ledger shape compatibility. */
export const FRESH_PRIOR_RECONCILED_SPEND_CNY = FRESH_LEDGER_OPENING_PRIOR_SPEND_CNY;
export const FRESH_BUDGET_EXTENSION_MAX_CNY = 0 as const;
/** The researcher cap.  Exceeding it is reported and never blocks execution. */
export const FRESH_INCREMENTAL_BUDGET_CAP_CNY = 100 as const;
export const FRESH_ABSOLUTE_ACCOUNTING_CEILING_CNY = FRESH_INCREMENTAL_BUDGET_CAP_CNY;
export const FRESH_GLOBAL_HARD_CAP_CNY = FRESH_ABSOLUTE_ACCOUNTING_CEILING_CNY;
/** Reporting-only total exposure: declared history + one conservative whole-task reserve. */
export const FRESH_PROTECTED_TOTAL_CNY = 29.891074 as const;
export const FRESH_RESERVED_CNY = FRESH_P95_RESERVATION_CNY;
export const FRESH_GLOBAL_CAP_CNY = FRESH_GLOBAL_HARD_CAP_CNY;
export const FRESH_RECONCILED_PRIOR_SPEND_CNY = FRESH_PRIOR_RECONCILED_SPEND_CNY;
export const FRESH_PEAK_PRICING = true as const;
export const FRESH_BUDGET_IS_TELEMETRY_ONLY = true as const;
export const FRESH_PEAK_RATES_CNY_PER_MILLION_TOKENS = { cacheHitInput: 0.3, cacheMissInput: 9, output: 27 } as const;
export const FRESH_OFFPEAK_RATES_CNY_PER_MILLION_TOKENS = { cacheHitInput: 0.15, cacheMissInput: 4.5, output: 13.5 } as const;

const ROUNDING_TOLERANCE_CNY = 1e-9;

function near(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= ROUNDING_TOLERANCE_CNY;
}

/** Mechanically re-derive the frozen prefix ladder instead of trusting copied prompt numbers. */
export function assertFreshPeakPrefixLadder(): void {
  if (!near(FRESH_PER_COMPLETE_TASK_PEAK_RESERVE_CNY * FRESH_FROZEN_N9_PREFIX_LENGTH, FRESH_N9_PEAK_EQUIVALENT_RESERVATION_CNY)) {
    throw new Error("FRESH_PEAK_PREFIX_LADDER_PER_TASK_MISMATCH");
  }
  if (!near(FRESH_N9_OFFPEAK_PROTECTED_RESERVATION_CNY * FRESH_PEAK_MULTIPLIER, FRESH_N9_PEAK_EQUIVALENT_RESERVATION_CNY)
    || !near(FRESH_N9_PEAK_EQUIVALENT_RESERVATION_CNY / FRESH_FROZEN_N9_PREFIX_LENGTH, FRESH_PER_COMPLETE_TASK_PEAK_RESERVE_CNY)) {
    throw new Error("FRESH_PEAK_PREFIX_LADDER_PEAK_EQUIVALENCE_MISMATCH");
  }
  for (const [count, expected] of Object.entries(FRESH_ACTIVE_PREFIX_N_PEAK_RESERVE_LADDER_CNY)) {
    if (!near(FRESH_PER_COMPLETE_TASK_PEAK_RESERVE_CNY * Number(count), expected)) {
      throw new Error(`FRESH_PEAK_PREFIX_LADDER_LADDER_MISMATCH:${count}`);
    }
  }
  if (!near(FRESH_PEAK_PROTECTED_RESERVATION_CNY, FRESH_PER_COMPLETE_TASK_PEAK_RESERVE_CNY)) {
    throw new Error("FRESH_PEAK_PROTECTED_RESERVATION_MISMATCH");
  }
  if (!near(FRESH_HISTORICAL_FRESH_SPEND_CNY + FRESH_REMAINING_FRESH_BUDGET_CNY, FRESH_INCREMENTAL_BUDGET_CAP_CNY)) {
    throw new Error("FRESH_ROLLING_BUDGET_REMAINING_MISMATCH");
  }
  if (FRESH_PEAK_RATES_CNY_PER_MILLION_TOKENS.cacheHitInput !== FRESH_OFFPEAK_RATES_CNY_PER_MILLION_TOKENS.cacheHitInput * FRESH_PEAK_MULTIPLIER
    || FRESH_PEAK_RATES_CNY_PER_MILLION_TOKENS.cacheMissInput !== FRESH_OFFPEAK_RATES_CNY_PER_MILLION_TOKENS.cacheMissInput * FRESH_PEAK_MULTIPLIER
    || FRESH_PEAK_RATES_CNY_PER_MILLION_TOKENS.output !== FRESH_OFFPEAK_RATES_CNY_PER_MILLION_TOKENS.output * FRESH_PEAK_MULTIPLIER) {
    throw new Error("FRESH_PEAK_PRICING_IS_NOT_EXACT_2X_OFFPEAK");
  }
  if (FRESH_EXPECTED_CALLS !== 540 || FRESH_MAX_CALLS !== 660) throw new Error("FRESH_PREFIX5_CALL_COUNT_MISMATCH");
  if (FRESH_EXPECTED_CALLS !== FRESH_ACTIVE_PREFIX_N * FRESH_BASE_ATTEMPTS_PER_TASK * FRESH_MAX_TURNS_PER_TRIAL
    || FRESH_MAX_CALLS !== FRESH_ACTIVE_PREFIX_N * FRESH_MAX_ATTEMPTS_PER_TASK * FRESH_MAX_TURNS_PER_TRIAL) {
    throw new Error("FRESH_PREFIX5_CALL_COUNT_DERIVATION_MISMATCH");
  }
  if (FRESH_PROTECTED_TOTAL_CNY !== 29.891074
    || !near(FRESH_HISTORICAL_FRESH_SPEND_CNY + FRESH_CONSERVATIVE_WHOLE_TASK_RESERVE_CNY, FRESH_PROTECTED_TOTAL_CNY)
    || FRESH_ABSOLUTE_ACCOUNTING_CEILING_CNY !== FRESH_INCREMENTAL_BUDGET_CAP_CNY) {
    throw new Error("FRESH_PREFIX5_CAP_ACCOUNTING_MISMATCH");
  }
}

assertFreshPeakPrefixLadder();

export const FRESH_PAID_AUTHORITY_BODY = {
  schemaVersion: "direction-a.evo-fresh-n9-paid-authority.v1",
  decisionId: "EVO_FRESH_PEAK100_PREFIX5_2026_09_14",
  scope: "EVO_FRESH_ENGINEERING_HOLDOUT",
  activePrefixN: FRESH_ACTIVE_PREFIX_N,
  freshN: FRESH_ACTIVE_PREFIX_N,
  expectedProviderCalls: FRESH_EXPECTED_CALLS,
  maximumProviderCalls: FRESH_MAX_CALLS,
  ledgerOpeningPriorSpendCny: FRESH_PRIOR_RECONCILED_SPEND_CNY,
  priorSpendTreatment: "HISTORICAL_FRESH_SPEND_CHARGED_TO_FRESH_CNY100",
  budgetMode: "OUTCOME_BLIND_ROLLING_WHOLE_TASK_RESERVE",
  budgetRole: "TELEMETRY_ONLY_NEVER_BLOCKS_EXECUTION",
  historicalFreshSpendCny: FRESH_HISTORICAL_FRESH_SPEND_CNY,
  remainingFreshBudgetCny: FRESH_REMAINING_FRESH_BUDGET_CNY,
  freshP95ReservationCny: FRESH_P95_RESERVATION_CNY,
  peakProtectedReservationCny: FRESH_PEAK_PROTECTED_RESERVATION_CNY,
  incrementalBudgetCapCny: FRESH_INCREMENTAL_BUDGET_CAP_CNY,
  absoluteAccountingCeilingCny: FRESH_ABSOLUTE_ACCOUNTING_CEILING_CNY,
  researcherBudgetExtensionMaximumCny: FRESH_BUDGET_EXTENSION_MAX_CNY,
  globalNewSpendHardCapCny: FRESH_GLOBAL_HARD_CAP_CNY,
  peakPricing: FRESH_PEAK_PRICING,
  pricingMode: "DEEPSEEK_V4_PRO_PEAK_WINDOW",
  ratesCnyPerMillionTokens: FRESH_PEAK_RATES_CNY_PER_MILLION_TOKENS,
  offpeakRatesCnyPerMillionTokens: FRESH_OFFPEAK_RATES_CNY_PER_MILLION_TOKENS,
  maxTurnsPerTrial: FRESH_MAX_TURNS_PER_TRIAL,
  maxAttemptsPerTask: FRESH_MAX_ATTEMPTS_PER_TASK,
  technicalReplacementLimitPerTask: FRESH_TECHNICAL_REPLACEMENT_LIMIT_PER_TASK,
  task6Forbidden: true,
  reservationBeforeSecretRead: true,
  dockerReadinessBeforeSecretRead: true,
  pair5Forbidden: true,
  noScientificScopeExpansion: true,
  budgetNeverFailsClosed: true,
} as const;

export const FRESH_PAID_AUTHORITY = immutableCopy({ ...FRESH_PAID_AUTHORITY_BODY,
  contentHash: hashCanonical(FRESH_PAID_AUTHORITY_BODY) });

export interface FreshBudgetExposure {
  priorReconciledSpendCny: number;
  actualFreshSpendCny: number;
  pendingUnknownReserveCny: number;
  remainingAuthorizedReservationCny: number;
  realizedProviderCalls: number;
  pendingProviderCalls: number;
  remainingAuthorizedCalls: number;
}

export interface FreshBudgetProjection extends FreshBudgetExposure {
  protectedExposureCny: number;
  protectedProviderCalls: number;
  remainingGlobalHeadroomCny: number;
  incrementalProtectedCny: number;
  remainingIncrementalHeadroomCny: number;
  /** Telemetry: true when reported spend exceeds the researcher cap.  It never blocks execution. */
  overDeclaredCap: boolean;
  /** Telemetry: realised + pending spend minus the declared historical spend. */
  newSpendSinceHistoricalCny: number;
}

function finiteNonNegative(value: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`FRESH_BUDGET_STATE_INVALID:${label}`);
  return value;
}

export function assertFreshPaidAuthority(): void {
  assertFreshPeakPrefixLadder();
  const { contentHash, ...body } = FRESH_PAID_AUTHORITY;
  if (hashCanonical(body) !== contentHash || body.scope !== "EVO_FRESH_ENGINEERING_HOLDOUT"
    || body.activePrefixN !== FRESH_ACTIVE_PREFIX_N || body.freshN !== FRESH_ACTIVE_PREFIX_N
    || body.expectedProviderCalls !== 540 || body.maximumProviderCalls !== 660
    || body.freshP95ReservationCny !== 19.868557 || body.peakProtectedReservationCny !== 19.868557
    || body.ledgerOpeningPriorSpendCny !== 0 || body.historicalFreshSpendCny !== 10.022517
    || body.priorSpendTreatment !== "HISTORICAL_FRESH_SPEND_CHARGED_TO_FRESH_CNY100"
    || body.budgetMode !== "OUTCOME_BLIND_ROLLING_WHOLE_TASK_RESERVE"
    || body.budgetRole !== "TELEMETRY_ONLY_NEVER_BLOCKS_EXECUTION" || body.remainingFreshBudgetCny !== 89.977483
    || body.incrementalBudgetCapCny !== 100 || body.absoluteAccountingCeilingCny !== 100
    || body.globalNewSpendHardCapCny !== 100 || body.peakPricing !== true
    || body.maxAttemptsPerTask !== 11 || body.technicalReplacementLimitPerTask !== 2
    || !body.task6Forbidden || !body.pair5Forbidden || !body.budgetNeverFailsClosed) {
    throw new Error("FRESH_PAID_AUTHORITY_MISMATCH");
  }
}

export function createFreshInitialBudgetExposure(): FreshBudgetExposure {
  return { priorReconciledSpendCny: FRESH_PRIOR_RECONCILED_SPEND_CNY, actualFreshSpendCny: 0,
    pendingUnknownReserveCny: 0, remainingAuthorizedReservationCny: 0,
    realizedProviderCalls: 0, pendingProviderCalls: 0, remainingAuthorizedCalls: FRESH_MAX_CALLS };
}

/**
 * Projects spend and call accounting.  Money is telemetry: overshoot is reported, never thrown.
 * Only the structural provider-call bound (the frozen 660-call protocol budget) fails closed.
 */
export function projectFreshBudgetExposure(input: FreshBudgetExposure): FreshBudgetProjection {
  assertFreshPaidAuthority();
  const value: FreshBudgetExposure = {
    priorReconciledSpendCny: finiteNonNegative(input.priorReconciledSpendCny, "priorReconciledSpendCny"),
    actualFreshSpendCny: finiteNonNegative(input.actualFreshSpendCny, "actualFreshSpendCny"),
    pendingUnknownReserveCny: finiteNonNegative(input.pendingUnknownReserveCny, "pendingUnknownReserveCny"),
    remainingAuthorizedReservationCny: finiteNonNegative(input.remainingAuthorizedReservationCny, "remainingAuthorizedReservationCny"),
    realizedProviderCalls: finiteNonNegative(input.realizedProviderCalls, "realizedProviderCalls"),
    pendingProviderCalls: finiteNonNegative(input.pendingProviderCalls, "pendingProviderCalls"),
    remainingAuthorizedCalls: finiteNonNegative(input.remainingAuthorizedCalls, "remainingAuthorizedCalls"),
  };
  if (value.priorReconciledSpendCny !== FRESH_PRIOR_RECONCILED_SPEND_CNY) throw new Error("FRESH_PRIOR_SPEND_BINDING_MISMATCH");
  if (value.remainingAuthorizedReservationCny !== 0) throw new Error("FRESH_UPFRONT_REMAINING_RESERVE_FORBIDDEN");
  const spentCny = value.priorReconciledSpendCny + value.actualFreshSpendCny + value.pendingUnknownReserveCny;
  const protectedProviderCalls = value.realizedProviderCalls + value.pendingProviderCalls + value.remainingAuthorizedCalls;
  if (protectedProviderCalls > FRESH_MAX_CALLS) throw new Error("FRESH_PROVIDER_CALL_CAP_EXCEEDED");
  return immutableCopy({ ...value, protectedExposureCny: spentCny, incrementalProtectedCny: spentCny,
    protectedProviderCalls, overDeclaredCap: spentCny > FRESH_INCREMENTAL_BUDGET_CAP_CNY + 1e-9,
    newSpendSinceHistoricalCny: spentCny - FRESH_HISTORICAL_FRESH_SPEND_CNY,
    remainingIncrementalHeadroomCny: FRESH_INCREMENTAL_BUDGET_CAP_CNY - spentCny,
    remainingGlobalHeadroomCny: FRESH_GLOBAL_HARD_CAP_CNY - spentCny });
}

export function reserveFreshDispatch(input: FreshBudgetExposure, reservationCny: number, maximumCalls: number): FreshBudgetExposure {
  const current = projectFreshBudgetExposure(input);
  finiteNonNegative(reservationCny, "reservationCny"); finiteNonNegative(maximumCalls, "maximumCalls");
  if (maximumCalls > current.remainingAuthorizedCalls) throw new Error("FRESH_DISPATCH_CALL_BOUND_EXCEEDED");
  const next = { ...input, pendingUnknownReserveCny: input.pendingUnknownReserveCny + reservationCny,
    pendingProviderCalls: input.pendingProviderCalls + maximumCalls, remainingAuthorizedCalls: input.remainingAuthorizedCalls - maximumCalls };
  projectFreshBudgetExposure(next); return immutableCopy(next);
}

export function reconcileFreshDispatch(input: FreshBudgetExposure, reservedUnknownCny: number, reservedCalls: number,
  actualCny: number, actualCalls: number): FreshBudgetExposure {
  projectFreshBudgetExposure(input);
  [reservedUnknownCny, reservedCalls, actualCny, actualCalls].forEach((value, index) => finiteNonNegative(value, `reconcile:${index}`));
  if (reservedUnknownCny > input.pendingUnknownReserveCny + 1e-9 || reservedCalls > input.pendingProviderCalls
    || actualCalls > reservedCalls) throw new Error("FRESH_RECONCILIATION_EXCEEDS_PENDING_RESERVATION");
  const next = { ...input, actualFreshSpendCny: input.actualFreshSpendCny + actualCny,
    pendingUnknownReserveCny: Math.max(0, input.pendingUnknownReserveCny - reservedUnknownCny),
    realizedProviderCalls: input.realizedProviderCalls + actualCalls, pendingProviderCalls: input.pendingProviderCalls - reservedCalls };
  projectFreshBudgetExposure(next); return immutableCopy(next);
}

export function releaseFreshDispatch(input: FreshBudgetExposure, reservedUnknownCny: number, reservedCalls: number): FreshBudgetExposure {
  projectFreshBudgetExposure(input); finiteNonNegative(reservedUnknownCny, "release:reservedUnknownCny"); finiteNonNegative(reservedCalls, "release:reservedCalls");
  if (reservedUnknownCny > input.pendingUnknownReserveCny + 1e-9 || reservedCalls > input.pendingProviderCalls) {
    throw new Error("FRESH_RELEASE_EXCEEDS_PENDING_RESERVATION");
  }
  const next = { ...input, pendingUnknownReserveCny: Math.max(0, input.pendingUnknownReserveCny - reservedUnknownCny),
    pendingProviderCalls: input.pendingProviderCalls - reservedCalls, remainingAuthorizedCalls: input.remainingAuthorizedCalls + reservedCalls };
  projectFreshBudgetExposure(next); return immutableCopy(next);
}

/**
 * Outcome-blind whole-task admission telemetry.  It accepts no outcome data, is called once before
 * a task's first paid attempt for reporting, and never blocks the run.
 */
export interface FreshWholeTaskReserve {
  taskId: string;
  conservativeReserveCny: number;
  coveringBudget: boolean;
  remainingFreshCny: number;
  budgetMode: "OUTCOME_BLIND_ROLLING_WHOLE_TASK_RESERVE";
  budgetRole: "TELEMETRY_ONLY";
}

export function reserveFreshWholeTaskBeforeStart(input: FreshBudgetExposure, taskId: string): FreshWholeTaskReserve {
  const current = projectFreshBudgetExposure(input);
  return immutableCopy({ taskId, conservativeReserveCny: FRESH_CONSERVATIVE_WHOLE_TASK_RESERVE_CNY,
    coveringBudget: FRESH_CONSERVATIVE_WHOLE_TASK_RESERVE_CNY <= current.remainingIncrementalHeadroomCny + 1e-9,
    remainingFreshCny: current.remainingIncrementalHeadroomCny,
    budgetMode: "OUTCOME_BLIND_ROLLING_WHOLE_TASK_RESERVE" as const, budgetRole: "TELEMETRY_ONLY" as const });
}

/** CNY reserved per single paid trial; ledger shape only, it has no admission authority. */
export const FRESH_RESERVE_PER_TRIAL_CNY = FRESH_ROLLING_WHOLE_TASK_RESERVE_CNY / FRESH_MAX_ATTEMPTS_PER_TASK;

export interface FreshBudgetLedgerEventBody {
  sequence: number;
  previousEventHash: string | "GENESIS";
  eventType: "RESERVATION_CREATED" | "RESERVATION_RECONCILED" | "RESERVATION_RELEASED";
  attemptId: string;
  reservedCny: number;
  reservedCalls: number;
  actualCny?: number;
  actualCalls?: number;
}
export type FreshBudgetLedgerEvent = FreshBudgetLedgerEventBody & { contentHash: string };

export function verifyFreshBudgetLedger(events: readonly FreshBudgetLedgerEvent[]): void {
  const open = new Set<string>(); const settled = new Set<string>();
  events.forEach((event, index) => {
    const { contentHash, ...body } = event;
    if (event.sequence !== index + 1 || event.previousEventHash !== (events[index - 1]?.contentHash ?? "GENESIS")
      || hashCanonical(body) !== contentHash || !event.attemptId.startsWith("fresh-n9-")) throw new Error("FRESH_BUDGET_LEDGER_CHAIN_MISMATCH");
    finiteNonNegative(event.reservedCny, "ledger:reservedCny"); finiteNonNegative(event.reservedCalls, "ledger:reservedCalls");
    if (event.eventType === "RESERVATION_CREATED") {
      if (open.has(event.attemptId) || settled.has(event.attemptId) || event.actualCny !== undefined || event.actualCalls !== undefined) {
        throw new Error("FRESH_BUDGET_LEDGER_DUPLICATE_RESERVATION");
      }
      open.add(event.attemptId);
    } else {
      if (!open.has(event.attemptId) || settled.has(event.attemptId)) throw new Error("FRESH_BUDGET_LEDGER_SETTLEMENT_WITHOUT_OPEN_RESERVATION");
      if (event.eventType === "RESERVATION_RECONCILED") {
        finiteNonNegative(event.actualCny ?? Number.NaN, "ledger:actualCny"); finiteNonNegative(event.actualCalls ?? Number.NaN, "ledger:actualCalls");
      } else if (event.actualCny !== undefined || event.actualCalls !== undefined) throw new Error("FRESH_BUDGET_LEDGER_RELEASE_MUST_HAVE_ZERO_USAGE");
      open.delete(event.attemptId); settled.add(event.attemptId);
    }
  });
}

export function appendFreshBudgetLedgerEvent(events: readonly FreshBudgetLedgerEvent[],
  event: Omit<FreshBudgetLedgerEventBody, "sequence" | "previousEventHash">): FreshBudgetLedgerEvent[] {
  verifyFreshBudgetLedger(events);
  const body: FreshBudgetLedgerEventBody = { sequence: events.length + 1, previousEventHash: events.at(-1)?.contentHash ?? "GENESIS", ...event };
  const next = [...events, immutableCopy({ ...body, contentHash: hashCanonical(body) }) as FreshBudgetLedgerEvent];
  verifyFreshBudgetLedger(next); projectFreshBudgetLedger(next); return next;
}

export function projectFreshBudgetLedger(events: readonly FreshBudgetLedgerEvent[]): FreshBudgetExposure {
  verifyFreshBudgetLedger(events); let exposure = createFreshInitialBudgetExposure();
  for (const event of events) {
    if (event.eventType === "RESERVATION_CREATED") exposure = reserveFreshDispatch(exposure, event.reservedCny, event.reservedCalls);
    else if (event.eventType === "RESERVATION_RECONCILED") exposure = reconcileFreshDispatch(exposure, event.reservedCny, event.reservedCalls,
      event.actualCny!, event.actualCalls!);
    else exposure = releaseFreshDispatch(exposure, event.reservedCny, event.reservedCalls);
  }
  return exposure;
}

/** Telemetry snapshot for reporting; never throws on spend. */
export interface FreshSpendTelemetry {
  declaredHistoricalSpendCny: number;
  ledgerActualSpendCny: number;
  ledgerPendingReserveCny: number;
  consumedAgainstCapCny: number;
  remainingAgainstCapCny: number;
  overDeclaredCap: boolean;
  realisedProviderCalls: number;
  pendingProviderCalls: number;
  remainingAuthorizedCalls: number;
  providerCallCap: number;
}

export function freshSpendTelemetry(events: readonly FreshBudgetLedgerEvent[]): FreshSpendTelemetry {
  const exposure = projectFreshBudgetLedger(events);
  const consumed = exposure.actualFreshSpendCny + exposure.pendingUnknownReserveCny;
  return immutableCopy({ declaredHistoricalSpendCny: FRESH_HISTORICAL_FRESH_SPEND_CNY,
    ledgerActualSpendCny: exposure.actualFreshSpendCny, ledgerPendingReserveCny: exposure.pendingUnknownReserveCny,
    consumedAgainstCapCny: consumed, remainingAgainstCapCny: FRESH_INCREMENTAL_BUDGET_CAP_CNY - consumed,
    overDeclaredCap: consumed > FRESH_INCREMENTAL_BUDGET_CAP_CNY + 1e-9,
    realisedProviderCalls: exposure.realizedProviderCalls, pendingProviderCalls: exposure.pendingProviderCalls,
    remainingAuthorizedCalls: exposure.remainingAuthorizedCalls, providerCallCap: FRESH_MAX_CALLS });
}

/**
 * The only execution-stopping condition left in the budget layer: the provider itself refuses the
 * request (balance / quota / billing).  Everything else is telemetry.
 */
export function isProviderRefusal(message: string): boolean {
  return /insufficient.?(?:balance|funds|quota|credit)|insufficient_user_quota|exceeded.?your.?current.?quota|quota.?exhausted|out.?of.?credit|payment.?required|billing|\b402\b|余额不足|额度不足|欠费/i
    .test(message);
}
