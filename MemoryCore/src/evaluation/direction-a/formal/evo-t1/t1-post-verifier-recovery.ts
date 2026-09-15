import { delimiter } from "node:path";

export const POST_VERIFIER_CLEANUP_CLASSIFICATION = "POST_VERIFIER_CLEANUP_EXCEPTION" as const;
export const REDUNDANT_DUE_TO_PREVIOUS_CLASSIFIER = "REDUNDANT_DUE_TO_PREVIOUS_CLASSIFIER" as const;

export interface PostVerifierCleanupProof {
  agentExecutionCompleted: boolean;
  agentResultDurableAndParseable: boolean;
  verifierExecutionCompleted: boolean;
  verifierResultDurableAndParseable: boolean;
  caseSummaryComplete: boolean;
  denominatorAccountingValid: boolean;
  trajectoryProvenanceDurableAndParseable: boolean;
  providerUsageAndCostReconciled: boolean;
  exceptionOccurredAfterMeasurement: boolean;
  cleanupTeardownOnly: boolean;
  taskGroupAttemptIdentityUnambiguous: boolean;
  dispatchUniqueAndReconciled: boolean;
}

export type PostVerifierCleanupCriterion = keyof PostVerifierCleanupProof;

export interface PostVerifierCleanupDecision {
  classification: typeof POST_VERIFIER_CLEANUP_CLASSIFICATION | "TECHNICAL_INVALID";
  salvageQualified: boolean;
  failedCriteria: PostVerifierCleanupCriterion[];
}

/**
 * Frozen anti-censoring classifier. It intentionally accepts no score, reward,
 * strict-pass, success-count, or failure-count field: qualification is based
 * only on completion, durability, accounting, timing, and provenance.
 */
export function classifyPostVerifierCleanup(proof: PostVerifierCleanupProof): PostVerifierCleanupDecision {
  const failedCriteria = (Object.entries(proof) as Array<[PostVerifierCleanupCriterion, boolean]>)
    .filter(([, proven]) => proven !== true)
    .map(([criterion]) => criterion);
  return failedCriteria.length === 0
    ? { classification: POST_VERIFIER_CLEANUP_CLASSIFICATION, salvageQualified: true, failedCriteria }
    : { classification: "TECHNICAL_INVALID", salvageQualified: false, failedCriteria };
}

export function isCompletedInterval(value: { started_at?: string; finished_at?: string } | undefined): boolean {
  if (!value?.started_at || !value.finished_at) return false;
  const start = Date.parse(value.started_at); const finish = Date.parse(value.finished_at);
  return Number.isFinite(start) && Number.isFinite(finish) && finish >= start;
}

export function isCleanupOnlyException(exceptionText: string): boolean {
  return /SAFE_DELETE_FAIL_CLOSED/i.test(exceptionText)
    && /cleanup_empty_mount_dirs/i.test(exceptionText)
    && /(?:dir_path\.rmdir|Path\.rmdir|_safe_path_rmdir)/i.test(exceptionText)
    && /windows-sandbox-recycle-bin-unavailable/i.test(exceptionText);
}

const WORKBUDDY_SHIM = /(?:^|[\\/])WorkBuddy[\\/].*?[\\/]cli[\\/]vendor[\\/]shim(?:[\\/]|$)/i;

/** Remove only the WorkBuddy sitecustomize injection at the Harbor child boundary. */
export function sanitizeHarborChildEnv(parent: NodeJS.ProcessEnv, required: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...parent };
  for (const key of Object.keys(child).filter((name) => name.toLowerCase() === "pythonpath")) {
    const retained = (child[key] ?? "").split(delimiter).filter((entry) => entry && !WORKBUDDY_SHIM.test(entry));
    if (retained.length) child[key] = retained.join(delimiter); else delete child[key];
  }
  return { ...child, ...required };
}

export interface SalvageAttempt {
  attemptId: string;
  dispatchSequence: number;
  resultHash: string;
  classification: PostVerifierCleanupDecision;
}

export interface CanonicalNormalSalvageDecision {
  salvage: "YES" | "NO";
  canonicalAttemptId: string | null;
  redundantAttemptIds: string[];
  qualifiedAttemptIdsInDispatchOrder: string[];
  rule: "EARLIEST_DISPATCH_ORDERED_SALVAGE_QUALIFIED_ATTEMPT";
}

export function decideCanonicalNormalSalvage(attempts: readonly SalvageAttempt[]): CanonicalNormalSalvageDecision {
  const seenSequences = new Set<number>(); const seenIds = new Set<string>();
  for (const attempt of attempts) {
    if (!Number.isInteger(attempt.dispatchSequence) || attempt.dispatchSequence < 1
      || seenSequences.has(attempt.dispatchSequence) || seenIds.has(attempt.attemptId)) {
      throw new Error("T1_D6_NORMAL_DISPATCH_PROVENANCE_AMBIGUOUS");
    }
    seenSequences.add(attempt.dispatchSequence); seenIds.add(attempt.attemptId);
  }
  const qualified = attempts.filter((attempt) => attempt.classification.salvageQualified)
    .sort((left, right) => left.dispatchSequence - right.dispatchSequence);
  return {
    salvage: qualified.length ? "YES" : "NO",
    canonicalAttemptId: qualified[0]?.attemptId ?? null,
    redundantAttemptIds: qualified.slice(1).map((attempt) => attempt.attemptId),
    qualifiedAttemptIdsInDispatchOrder: qualified.map((attempt) => attempt.attemptId),
    rule: "EARLIEST_DISPATCH_ORDERED_SALVAGE_QUALIFIED_ATTEMPT",
  };
}

export function selectCanonicalNormalTrainingRows<T extends { attemptId: string }>(
  decision: CanonicalNormalSalvageDecision,
  rows: readonly T[],
): T[] {
  if (!decision.canonicalAttemptId) return [];
  const selected = rows.filter((row) => row.attemptId === decision.canonicalAttemptId);
  if (selected.length !== 1) throw new Error("T1_D6_CANONICAL_NORMAL_ROW_CARDINALITY_INVALID");
  return selected;
}

export interface RemainingT1Scope {
  salvage: "YES" | "NO";
  groups: Array<{ officialDomainId: "d6" | "d3"; normalTrials: number; causalArmTrials: 8; baseTrials: number;
    remainingTechnicalReserveTrials: number; maximumTrials: number; remainingReservationCny: number }>;
  remainingBaseTrials: number;
  remainingExpectedProviderCalls: number;
  remainingMaximumProviderCalls: number;
  historicalProviderCalls: number;
  totalProviderCallsAtRemainingMaximum: number;
  historicalObservedCostCny: number;
  remainingT1StageAffordabilityCny: number;
  remainingGlobalAffordabilityCny: number;
  stageHardCapCny: 36.4;
  globalHardCapCny: 100;
  pair5Forbidden: true;
  t2Authorized: false;
  freshAuthorized: false;
  q6Authorized: false;
}

export function buildRemainingT1Scope(input: {
  salvage: "YES" | "NO";
  historicalProviderCalls: number;
  historicalObservedCostCny: number;
}): RemainingT1Scope {
  if (!Number.isInteger(input.historicalProviderCalls) || input.historicalProviderCalls < 0
    || !Number.isFinite(input.historicalObservedCostCny) || input.historicalObservedCostCny < 0
    || input.historicalObservedCostCny > 36.4) throw new Error("T1_REMAINING_SCOPE_ACCOUNTING_INVALID");
  const d6Normal = input.salvage === "YES" ? 0 : 1;
  // One historical extra NORMAL dispatch consumed one of d6's two frozen
  // complete-group replacement trials. If neither old attempt is salvageable,
  // both historical dispatches consume the d6 reserve and the reauthorized
  // NORMAL is base completion work, not a third replacement.
  const d6Reserve = input.salvage === "YES" ? 1 : 0;
  const groups: RemainingT1Scope["groups"] = [
    { officialDomainId: "d6", normalTrials: d6Normal, causalArmTrials: 8, baseTrials: d6Normal + 8,
      remainingTechnicalReserveTrials: d6Reserve, maximumTrials: 9, remainingReservationCny: 18.2 - input.historicalObservedCostCny },
    { officialDomainId: "d3", normalTrials: 1, causalArmTrials: 8, baseTrials: 9,
      remainingTechnicalReserveTrials: 2, maximumTrials: 11, remainingReservationCny: 18.2 },
  ];
  const remainingBaseTrials = groups.reduce((sum, group) => sum + group.baseTrials, 0);
  const remainingMaximumTrials = groups.reduce((sum, group) => sum + group.maximumTrials, 0);
  return {
    salvage: input.salvage, groups, remainingBaseTrials,
    remainingExpectedProviderCalls: remainingBaseTrials * 12,
    remainingMaximumProviderCalls: remainingMaximumTrials * 12,
    historicalProviderCalls: input.historicalProviderCalls,
    totalProviderCallsAtRemainingMaximum: input.historicalProviderCalls + remainingMaximumTrials * 12,
    historicalObservedCostCny: input.historicalObservedCostCny,
    remainingT1StageAffordabilityCny: 36.4 - input.historicalObservedCostCny,
    remainingGlobalAffordabilityCny: 100 - input.historicalObservedCostCny,
    stageHardCapCny: 36.4, globalHardCapCny: 100, pair5Forbidden: true,
    t2Authorized: false, freshAuthorized: false, q6Authorized: false,
  };
}
