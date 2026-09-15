import { hashCanonical, immutableCopy } from "../core/canonical.js";
import { assertActualArmStartOrderFromJournal, type PairStartJournalEvidence } from "../acquisition/integrity.js";
import { assertT1PairOrderRecoveryManifest, recoverySlots, type T1PairOrderRecoveryManifest } from "./t1-pair-order-recovery.js";

export const T1_ANTI_CENSORING_CONTINUATION_PURPOSE = "EVO_T1_ANTI_CENSORING_CONTINUATION" as const;
export const T1_ANTI_CENSORING_CONTINUATION_RUNTIME_ROOT = "C:\\Users\\L2503\\Desktop\\TencentDB-Agent-Memory\\Direction_A_Evo_T1_AntiCensoring_Continuation_Runtime_v1" as const;
export const RECLASSIFIED_T1_ATTEMPT_ID = "t1-pair-order-recovery-1-p2-remove-try-1" as const;

export type ContinuationSlotStatus = "HISTORICAL_SCIENTIFIC_FAILURE" | "PENDING" | "DISPATCHED" | "RECONCILED" | "SCIENTIFIC_FAILURE" | "TECHNICAL_INVALID" | "UNCERTAIN";
export interface T1ContinuationSlot {
  key: string;
  taskId: string;
  causalGroupId: string;
  pairIndex: number;
  arm: "FULL" | "REMOVE";
  attemptId: string;
  status: ContinuationSlotStatus;
}

export interface T1HistoricalCorrectionBinding {
  contentHash: string;
  attemptId: typeof RECLASSIFIED_T1_ATTEMPT_ID;
  historicalClassification: "TECHNICAL_INVALID";
  currentDerivedClassification: "SCIENTIFIC_FAILURE";
  scientificFailureReason: "COMPILE_FAILURE";
  derivedOutcome: { numerator: 0; denominator: number; utility: 0; strictPass: false };
  rawJournalSha256: string;
  historicalStateSha256: string;
  harborResultSha256: string;
  verifierOutputSha256: string;
  frozenVerifierSha256: string;
  gradingPolicySha256: string;
}

export function assertT1HistoricalCorrectionBinding(value: T1HistoricalCorrectionBinding, expected?: {
  attemptId: string; historicalStateSha256: string; harborResultSha256: string; verifierOutputSha256: string;
  frozenVerifierSha256: string; gradingPolicySha256: string;
}): void {
  const { contentHash, ...body } = value;
  const hashes = [value.rawJournalSha256, value.historicalStateSha256, value.harborResultSha256,
    value.verifierOutputSha256, value.frozenVerifierSha256, value.gradingPolicySha256];
  if (hashCanonical(body) !== contentHash || hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))
    || value.attemptId !== RECLASSIFIED_T1_ATTEMPT_ID || value.historicalClassification !== "TECHNICAL_INVALID"
    || value.currentDerivedClassification !== "SCIENTIFIC_FAILURE" || value.scientificFailureReason !== "COMPILE_FAILURE"
    || value.derivedOutcome.numerator !== 0 || value.derivedOutcome.utility !== 0 || value.derivedOutcome.strictPass
    || !Number.isInteger(value.derivedOutcome.denominator) || value.derivedOutcome.denominator < 1) {
    throw new Error("T1_HISTORICAL_CORRECTION_HASH_OR_SEMANTICS_MISMATCH");
  }
  if (expected && (value.attemptId !== expected.attemptId || value.historicalStateSha256 !== expected.historicalStateSha256
    || value.harborResultSha256 !== expected.harborResultSha256 || value.verifierOutputSha256 !== expected.verifierOutputSha256
    || value.frozenVerifierSha256 !== expected.frozenVerifierSha256 || value.gradingPolicySha256 !== expected.gradingPolicySha256)) {
    throw new Error("T1_HISTORICAL_CORRECTION_IMMUTABLE_EVIDENCE_MISMATCH");
  }
}

export interface T1ContinuationState {
  schemaVersion: "direction-a.evo-t1-anti-censoring-continuation-state.v1";
  purpose: typeof T1_ANTI_CENSORING_CONTINUATION_PURPOSE;
  runtimeRoot: typeof T1_ANTI_CENSORING_CONTINUATION_RUNTIME_ROOT;
  historicalStateSha256: string;
  correctionArtifactHash: string;
  historicalAttemptRedispatchForbidden: true;
  slots: T1ContinuationSlot[];
  nextLegalDispatch: string;
  remainingProviderCallsMaximum: number;
  contentHash: string;
}

function attemptIdForSlot(slot: { causalGroupId: string; pairIndex: number; arm: "FULL" | "REMOVE" }, firstGroupId: string): string {
  return `t1-anti-censoring-continuation-${slot.causalGroupId === firstGroupId ? 1 : 2}-p${slot.pairIndex}-${slot.arm.toLowerCase()}-try-1`;
}

export function buildT1ContinuationState(input: {
  manifest: T1PairOrderRecoveryManifest;
  historicalState: { slots: Array<{ key: string; attemptId: string; status: string }>; contentHash: string };
  historicalStateSha256: string;
  correction: T1HistoricalCorrectionBinding;
  callsPerArm: number;
}): T1ContinuationState {
  assertT1PairOrderRecoveryManifest(input.manifest);
  assertT1HistoricalCorrectionBinding(input.correction);
  const historicalBody = { ...input.historicalState } as Record<string, unknown>;
  delete historicalBody.contentHash;
  if (hashCanonical(historicalBody) !== input.historicalState.contentHash) throw new Error("T1_CONTINUATION_HISTORICAL_STATE_CONTENT_HASH_MISMATCH");
  if (input.correction.attemptId !== RECLASSIFIED_T1_ATTEMPT_ID || input.correction.historicalStateSha256 !== input.historicalStateSha256
    || input.correction.historicalClassification !== "TECHNICAL_INVALID" || input.correction.currentDerivedClassification !== "SCIENTIFIC_FAILURE"
    || input.correction.scientificFailureReason !== "COMPILE_FAILURE" || input.correction.derivedOutcome.utility !== 0) {
    throw new Error("T1_CONTINUATION_CORRECTION_BINDING_MISMATCH");
  }
  const all = recoverySlots(input.manifest);
  const first = all[0];
  const historicalKey = `${first.causalGroupId}:P${first.pairIndex}:${first.arm}`;
  if (first.arm !== "REMOVE" || first.pairIndex !== 2 || input.historicalState.slots.length !== 1
    || input.historicalState.slots[0].key !== historicalKey || input.historicalState.slots[0].attemptId !== RECLASSIFIED_T1_ATTEMPT_ID
    || input.historicalState.slots[0].status !== "TECHNICAL_INVALID") throw new Error("T1_CONTINUATION_HISTORICAL_SLOT_IDENTITY_MISMATCH");
  if (!Number.isInteger(input.callsPerArm) || input.callsPerArm !== 12) throw new Error("T1_CONTINUATION_CALL_PROFILE_MISMATCH");
  const slots: T1ContinuationSlot[] = all.map((slot, index) => ({ ...slot,
    key: `${slot.causalGroupId}:P${slot.pairIndex}:${slot.arm}`,
    attemptId: index === 0 ? RECLASSIFIED_T1_ATTEMPT_ID : attemptIdForSlot(slot, first.causalGroupId),
    status: index === 0 ? "HISTORICAL_SCIENTIFIC_FAILURE" : "PENDING",
  }));
  const remaining = slots.filter((row) => row.status === "PENDING");
  if (remaining.length !== 7 || remaining[0].arm !== "FULL" || remaining[0].pairIndex !== 2
    || remaining.some((row) => row.pairIndex === 5 || (row.arm as string) === "NORMAL")) throw new Error("T1_CONTINUATION_REMAINING_SCOPE_MISMATCH");
  const body = { schemaVersion: "direction-a.evo-t1-anti-censoring-continuation-state.v1" as const,
    purpose: T1_ANTI_CENSORING_CONTINUATION_PURPOSE, runtimeRoot: T1_ANTI_CENSORING_CONTINUATION_RUNTIME_ROOT,
    historicalStateSha256: input.historicalStateSha256, correctionArtifactHash: input.correction.contentHash,
    historicalAttemptRedispatchForbidden: true as const, slots, nextLegalDispatch: remaining[0].key,
    remainingProviderCallsMaximum: remaining.length * input.callsPerArm };
  return immutableCopy({ ...body, contentHash: hashCanonical(body) }) as T1ContinuationState;
}

export function assertT1ContinuationState(value: T1ContinuationState): void {
  const { contentHash, ...body } = value;
  if (hashCanonical(body) !== contentHash || value.purpose !== T1_ANTI_CENSORING_CONTINUATION_PURPOSE
    || value.runtimeRoot !== T1_ANTI_CENSORING_CONTINUATION_RUNTIME_ROOT || !value.historicalAttemptRedispatchForbidden) {
    throw new Error("T1_CONTINUATION_STATE_HASH_OR_PURPOSE_MISMATCH");
  }
  const active = value.slots.filter((row) => row.status === "PENDING" || row.status === "DISPATCHED" || row.status === "UNCERTAIN");
  if (value.slots[0].attemptId !== RECLASSIFIED_T1_ATTEMPT_ID || value.slots[0].status !== "HISTORICAL_SCIENTIFIC_FAILURE"
    || value.slots.slice(1).length !== 7 || value.remainingProviderCallsMaximum !== 84 || active.some((row) => row.attemptId === RECLASSIFIED_T1_ATTEMPT_ID)) {
    throw new Error("T1_CONTINUATION_STATE_SCOPE_MISMATCH");
  }
}

export function nextT1ContinuationSlot(state: T1ContinuationState): T1ContinuationSlot | undefined {
  assertT1ContinuationState(state);
  if (state.slots.some((row) => row.status === "DISPATCHED" || row.status === "UNCERTAIN" || row.status === "TECHNICAL_INVALID")) {
    throw new Error("T1_CONTINUATION_AUTHORITY_GATE_REQUIRED");
  }
  return state.slots.find((row) => row.status === "PENDING");
}

export function assertT1ContinuationDispatchAllowed(state: T1ContinuationState, slot: T1ContinuationSlot): void {
  const next = nextT1ContinuationSlot(state);
  if (!next || next.key !== slot.key || slot.attemptId === RECLASSIFIED_T1_ATTEMPT_ID) throw new Error("T1_CONTINUATION_DUPLICATE_OR_OUT_OF_ORDER_DISPATCH_FORBIDDEN");
}

export interface T1ReservationReconciliation {
  schemaVersion: "direction-a.evo-t1-reservation-transfer-reconciliation.v1";
  historicalPriorSpendCny: number;
  completedArmActualSpendCny: number;
  currentObservedEvoSpendCny: number;
  originalReservationCny: number;
  originalReservedCalls: number;
  remainingAuthorizedCalls: number;
  transferredReservationCny: number;
  releasedReservationCny: number;
  protectedExposureCny: number;
  globalHardCapCny: number;
  oldReservationCountedConcurrently: false;
  contentHash: string;
}

export function reconcileT1Reservation(input: { historicalPriorSpendCny: number; completedArmActualSpendCny: number;
  originalReservationCny: number; originalReservedCalls: number; remainingAuthorizedCalls: number; globalHardCapCny: number }): T1ReservationReconciliation {
  const values = Object.values(input);
  if (values.some((value) => !Number.isFinite(value) || value < 0) || !Number.isInteger(input.originalReservedCalls)
    || !Number.isInteger(input.remainingAuthorizedCalls) || input.remainingAuthorizedCalls >= input.originalReservedCalls) {
    throw new Error("T1_RESERVATION_RECONCILIATION_INPUT_INVALID");
  }
  const currentObservedEvoSpendCny = input.historicalPriorSpendCny + input.completedArmActualSpendCny;
  const transferredReservationCny = input.originalReservationCny * input.remainingAuthorizedCalls / input.originalReservedCalls;
  const unusedAfterActual = input.originalReservationCny - input.completedArmActualSpendCny;
  const releasedReservationCny = unusedAfterActual - transferredReservationCny;
  const protectedExposureCny = currentObservedEvoSpendCny + transferredReservationCny;
  if (releasedReservationCny < -1e-12 || protectedExposureCny > input.globalHardCapCny + 1e-12) throw new Error("T1_RESERVATION_RECONCILIATION_CAP_OR_TRANSFER_INVALID");
  const body = { schemaVersion: "direction-a.evo-t1-reservation-transfer-reconciliation.v1" as const,
    historicalPriorSpendCny: input.historicalPriorSpendCny, completedArmActualSpendCny: input.completedArmActualSpendCny,
    currentObservedEvoSpendCny, originalReservationCny: input.originalReservationCny, originalReservedCalls: input.originalReservedCalls,
    remainingAuthorizedCalls: input.remainingAuthorizedCalls, transferredReservationCny, releasedReservationCny,
    protectedExposureCny, globalHardCapCny: input.globalHardCapCny, oldReservationCountedConcurrently: false as const };
  return immutableCopy({ ...body, contentHash: hashCanonical(body) }) as T1ReservationReconciliation;
}

export function assertContinuationPairOrder(input: { manifest: T1PairOrderRecoveryManifest; causalGroupId: string; pairIndex: number;
  historicalStarts: readonly PairStartJournalEvidence[]; continuationStarts: readonly PairStartJournalEvidence[] }): readonly PairStartJournalEvidence[] {
  assertT1PairOrderRecoveryManifest(input.manifest);
  const group = input.manifest.groups.find((row) => row.causalGroupId === input.causalGroupId);
  if (!group || !group.recoveryPairIndices.includes(input.pairIndex)) throw new Error("T1_CONTINUATION_PAIR_NOT_AUTHORIZED");
  if (input.historicalStarts.length) {
    if (input.historicalStarts.length !== 1 || input.continuationStarts.length !== 1) throw new Error("T1_CONTINUATION_CROSS_JOURNAL_PAIR_EVIDENCE_INCOMPLETE");
    const combined = [input.historicalStarts[0], input.continuationStarts[0]].map((row, index) => ({ ...row, sequence: index + 1 }));
    assertActualArmStartOrderFromJournal({ schedule: group.pairSchedule, pairIndex: input.pairIndex,
      taskId: group.taskId, causalGroupId: group.causalGroupId, starts: combined });
    return [input.historicalStarts[0], input.continuationStarts[0]];
  }
  return assertActualArmStartOrderFromJournal({ schedule: group.pairSchedule, pairIndex: input.pairIndex,
    taskId: group.taskId, causalGroupId: group.causalGroupId, starts: input.continuationStarts });
}
