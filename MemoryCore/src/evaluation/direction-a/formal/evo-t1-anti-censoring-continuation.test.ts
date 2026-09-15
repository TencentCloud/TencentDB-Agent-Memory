import { describe, expect, it } from "vitest";
import { hashCanonical } from "./core/canonical.js";
import { buildT1ContinuationState, assertContinuationPairOrder, assertT1ContinuationDispatchAllowed, assertT1HistoricalCorrectionBinding,
  nextT1ContinuationSlot, reconcileT1Reservation, RECLASSIFIED_T1_ATTEMPT_ID, type T1HistoricalCorrectionBinding } from "./evo-t1/t1-anti-censoring-continuation.js";
import type { T1PairOrderRecoveryManifest } from "./evo-t1/t1-pair-order-recovery.js";

const schedule = (seed: string, orders: Array<"FULL_FIRST" | "REMOVE_FIRST">) => {
  const body = { schemaVersion: "direction-a.pair-schedule.v1" as const, orderSeed: seed,
    orderPolicyVersion: "direction-a.counterbalanced-hash-order.v1" as const,
    rows: orders.map((scheduledArmOrder, index) => ({ pairIndex: index + 1, scheduledArmOrder })) };
  return { ...body, scheduleHash: hashCanonical(body) };
};
const manifest = (() => {
  const body = { schemaVersion: "direction-a.evo-t1-pair-order-recovery-manifest.v1" as const,
    purpose: "EVO_T1_PAIR_ORDER_INTEGRITY_RECOVERY" as const,
    runtimeRoot: "C:\\Users\\L2503\\Desktop\\TencentDB-Agent-Memory\\Direction_A_Evo_T1_PairOrder_Recovery_Runtime_v1" as const,
    groups: [
      { officialDomainId: "d6" as const, taskId: "d6", causalGroupId: "g6", pairSchedule: schedule("d6", ["FULL_FIRST", "REMOVE_FIRST", "FULL_FIRST", "REMOVE_FIRST"]), recoveryPairIndices: [2, 4] },
      { officialDomainId: "d3" as const, taskId: "d3", causalGroupId: "g3", pairSchedule: schedule("d3", ["FULL_FIRST", "REMOVE_FIRST", "REMOVE_FIRST", "FULL_FIRST"]), recoveryPairIndices: [2, 3] }],
    normalTrials: 0 as const, baseArmTrials: 8 as const, expectedProviderCalls: 96 as const, pair5Forbidden: true as const,
    technicalCompletionAuthority: "RECOVERY_TECHNICAL_COMPLETION_AUTHORITY_REQUIRED_IF_TRIGGERED" as const };
  return { ...body, contentHash: hashCanonical(body) } as T1PairOrderRecoveryManifest;
})();
const historicalBody = { schemaVersion: "direction-a.evo-t1-pair-order-recovery-state.v1", status: "RUNNING",
  slots: [{ key: "g6:P2:REMOVE", attemptId: RECLASSIFIED_T1_ATTEMPT_ID, status: "TECHNICAL_INVALID" }] };
const historicalState = { ...historicalBody, contentHash: hashCanonical(historicalBody) };
const correctionBody = { attemptId: RECLASSIFIED_T1_ATTEMPT_ID, historicalClassification: "TECHNICAL_INVALID" as const,
  currentDerivedClassification: "SCIENTIFIC_FAILURE" as const, scientificFailureReason: "COMPILE_FAILURE" as const,
  derivedOutcome: { numerator: 0 as const, denominator: 362, utility: 0 as const, strictPass: false as const },
  rawJournalSha256: "1".repeat(64), historicalStateSha256: "2".repeat(64), harborResultSha256: "3".repeat(64),
  verifierOutputSha256: "4".repeat(64), frozenVerifierSha256: "5".repeat(64), gradingPolicySha256: "6".repeat(64) };
const correction = { ...correctionBody, contentHash: hashCanonical(correctionBody) } as T1HistoricalCorrectionBinding;
const state = () => buildT1ContinuationState({ manifest, historicalState, historicalStateSha256: "2".repeat(64), correction, callsPerArm: 12 });

describe("T1 anti-censoring continuation", () => {
  it("imports the historical REMOVE once and starts exactly at d6 P2 FULL", () => {
    const value = state();
    expect(value.slots[0]).toMatchObject({ arm: "REMOVE", status: "HISTORICAL_SCIENTIFIC_FAILURE", attemptId: RECLASSIFIED_T1_ATTEMPT_ID });
    expect(nextT1ContinuationSlot(value)).toMatchObject({ causalGroupId: "g6", pairIndex: 2, arm: "FULL" });
    expect(value.slots.slice(1)).toHaveLength(7);
    expect(value.remainingProviderCallsMaximum).toBe(84);
  });

  it("forbids redispatch and out-of-order scope", () => {
    const value = state();
    expect(() => assertT1ContinuationDispatchAllowed(value, value.slots[0])).toThrow(/FORBIDDEN/);
    expect(() => assertT1ContinuationDispatchAllowed(value, value.slots[2])).toThrow(/FORBIDDEN/);
    expect(() => assertT1ContinuationDispatchAllowed(value, value.slots[1])).not.toThrow();
    expect(value.slots.some((row) => row.pairIndex === 5 || (row.arm as string) === "NORMAL")).toBe(false);
  });

  it("fails closed on correction attempt/result/verifier hash drift", () => {
    const expected = { attemptId: RECLASSIFIED_T1_ATTEMPT_ID, historicalStateSha256: "2".repeat(64), harborResultSha256: "3".repeat(64),
      verifierOutputSha256: "4".repeat(64), frozenVerifierSha256: "5".repeat(64), gradingPolicySha256: "6".repeat(64) };
    expect(() => assertT1HistoricalCorrectionBinding(correction, expected)).not.toThrow();
    expect(() => assertT1HistoricalCorrectionBinding({ ...correction, attemptId: "wrong" as typeof RECLASSIFIED_T1_ATTEMPT_ID }, expected)).toThrow();
    const driftBody = { ...correction, harborResultSha256: "9".repeat(64) }; delete (driftBody as Partial<typeof correction>).contentHash;
    const drift = { ...driftBody, contentHash: hashCanonical(driftBody) } as T1HistoricalCorrectionBinding;
    expect(() => assertT1HistoricalCorrectionBinding(drift, expected)).toThrow(/IMMUTABLE_EVIDENCE/);
    const verifierDriftBody = { ...correction, verifierOutputSha256: "8".repeat(64) }; delete (verifierDriftBody as Partial<typeof correction>).contentHash;
    const verifierDrift = { ...verifierDriftBody, contentHash: hashCanonical(verifierDriftBody) } as T1HistoricalCorrectionBinding;
    expect(() => assertT1HistoricalCorrectionBinding(verifierDrift, expected)).toThrow(/IMMUTABLE_EVIDENCE/);
  });

  it("stops on true technical invalid instead of silently retrying", () => {
    const original = state(); const body = { ...original, slots: original.slots.map((row, index) => index === 1 ? { ...row, status: "TECHNICAL_INVALID" as const } : { ...row }) };
    const { contentHash: _oldHash, ...rehashBody } = body; const value = { ...rehashBody, contentHash: hashCanonical(rehashBody) };
    expect(() => nextT1ContinuationSlot(value)).toThrow(/AUTHORITY_GATE/);
  });

  it("combines historical REMOVE and future FULL start evidence", () => {
    const row = (sequence: number, eventHash: string, attemptId: string, arm: "FULL" | "REMOVE") => ({ sequence, eventHash, attemptId,
      taskId: "d6", causalGroupId: "g6", pairIndex: 2, arm });
    const ordered = assertContinuationPairOrder({ manifest, causalGroupId: "g6", pairIndex: 2,
      historicalStarts: [row(2, "old", RECLASSIFIED_T1_ATTEMPT_ID, "REMOVE")], continuationStarts: [row(1, "new", "full", "FULL")] });
    expect(ordered.map((entry) => entry.arm)).toEqual(["REMOVE", "FULL"]);
  });

  it("fails closed on actual pair-order mismatch", () => {
    const row = (sequence: number, arm: "FULL" | "REMOVE") => ({ sequence, eventHash: `${sequence}`, attemptId: `${sequence}`,
      taskId: "d6", causalGroupId: "g6", pairIndex: 2, arm });
    expect(() => assertContinuationPairOrder({ manifest, causalGroupId: "g6", pairIndex: 2,
      historicalStarts: [row(1, "FULL")], continuationStarts: [row(2, "REMOVE")] })).toThrow(/ACTUAL_ORDER_MISMATCH/);
  });

  it("transfers reservation without double-counting and retains spend", () => {
    const value = reconcileT1Reservation({ historicalPriorSpendCny: 11.138481, completedArmActualSpendCny: .7996275,
      originalReservationCny: 15.140165777777778, originalReservedCalls: 96, remainingAuthorizedCalls: 84, globalHardCapCny: 110 });
    expect(value.currentObservedEvoSpendCny).toBeCloseTo(11.9381085, 12);
    expect(value.transferredReservationCny).toBeCloseTo(13.247645055555556, 12);
    expect(value.oldReservationCountedConcurrently).toBe(false);
    expect(value.protectedExposureCny).toBeLessThanOrEqual(110);
  });

  it("fails closed when the cap cannot support the transfer", () => {
    expect(() => reconcileT1Reservation({ historicalPriorSpendCny: 100, completedArmActualSpendCny: 1,
      originalReservationCny: 15, originalReservedCalls: 96, remainingAuthorizedCalls: 84, globalHardCapCny: 110 })).toThrow(/CAP_OR_TRANSFER/);
  });
});
