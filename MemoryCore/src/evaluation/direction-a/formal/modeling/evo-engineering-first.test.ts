import { describe, expect, it } from "vitest";
import {
  assertDispatchAffordable,
  chooseLargestAffordableFreshN,
  engineeringPolicyMetrics,
  evaluateT2Trigger,
  matchedBudgetDeltaV70,
  pairedTaskClusterBootstrapDeltaV70,
  roundHalfUp,
  selectEngineeringCandidate,
  type EvoBudgetLedger,
} from "./evo-engineering-first.js";

const prediction = (task: string, score: number, theta: number) => ({
  causalGroupId: `${task}:g`, statisticalClusterId: task, score, thetaHatFixed4: theta,
});

describe("Evo engineering-first freeze", () => {
  it("uses round-half-up and fixes the 70 percent accepted count", () => {
    expect(roundHalfUp(0.70 * 5)).toBe(4);
    expect(roundHalfUp(0.70 * 13)).toBe(9);
    const rows = Array.from({ length: 13 }, (_, index) => prediction(`t${index.toString().padStart(2, "0")}`, index, index / 100));
    expect(engineeringPolicyMetrics(rows).acceptedN).toBe(9);
  });

  it("selects policy value before rank and never minimizes RMSE among eligible candidates", () => {
    const targets = [0.05, 0.04, 0.03, 0.02, 0.01, 0];
    const policyFirst = [0.20, 0.18, 0.16, 0.14, 0.12, 0.10].map((score, index) => prediction(`t${index}`, score, targets[index]));
    const rmseFirst = [...targets].reverse().map((score, index) => prediction(`t${index}`, score, targets[index]));
    const selected = selectEngineeringCandidate([
      { candidateId: "POLICY", predictions: policyFirst, complexityRank: 1, onlineCostRank: 1 },
      { candidateId: "RMSE", predictions: rmseFirst, complexityRank: 0, onlineCostRank: 0 },
    ], { fallbackOrder: ["RMSE", "POLICY"] });
    expect(selected.metrics.POLICY.errorGuardrailPass).toBe(true);
    expect(selected.metrics.RMSE.errorGuardrailPass).toBe(true);
    expect(selected.winnerId).toBe("POLICY");
  });

  it("keeps task clusters independent when tasks contain unequal group counts", () => {
    const rows = [
      prediction("many", 1, 0.2), prediction("many", 0.8, 0.2), prediction("many", 0.6, 0.2),
      prediction("one", -1, -0.2),
    ];
    const metrics = engineeringPolicyMetrics(rows, 0.5);
    expect(metrics.independentClusters).toBe(2);
    expect(metrics.groups).toBe(4);
    expect(metrics.acceptedN).toBe(1);
    expect(metrics.policyValue).toBeCloseTo(0.2, 12);
  });

  it("freezes stable versus exactly-two-group T2 with no T3", () => {
    const theta = [0.4, 0.3, 0.2, 0.1, -0.1, -0.2, -0.3, -0.4];
    const candidate = (id: string, reverse = false) => ({
      candidateId: id,
      predictions: theta.map((value, index) => prediction(`t${index}`, reverse ? -value : value, value)),
      complexityRank: reverse ? 1 : 0,
      onlineCostRank: reverse ? 1 : 0,
      foldSelections: Array.from({ length: 8 }, () => ({ featureBlock: "EVO_SHARED_ONLY" as const, lambda: 100 })),
    });
    const result = evaluateT2Trigger({ candidates: [candidate("GOOD"), candidate("BAD", true)], fallbackOrder: ["GOOD", "BAD"] });
    expect(result.branch).toBe("STABLE_FREEZE_NO_T2");
    expect(result.noT3).toBe(true);
    const unstable = evaluateT2Trigger({ candidates: [{ ...candidate("GOOD"), foldSelections: [
      ...Array.from({ length: 4 }, () => ({ featureBlock: "EVO_SHARED_ONLY" as const, lambda: 100 })),
      ...Array.from({ length: 4 }, () => ({ featureBlock: "EVO_SHARED_PLUS_PROCESS" as const, lambda: 10 })),
    ] }, candidate("BAD", true)], fallbackOrder: ["GOOD", "BAD"] });
    expect(unstable.branch).toBe("UNSTABLE_RUN_EXACTLY_TWO_GROUP_T2");
  });

  it("matches accepted capacity and computes DeltaV70 from paired task contributions", () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      taskId: `t${index}`,
      thetaFixed4: index / 10,
      proposedScore: index,
      legacyScore: -index,
    }));
    const result = matchedBudgetDeltaV70(rows);
    expect(result.acceptedN).toBe(7);
    expect(result.proposedAcceptedTaskIds).toHaveLength(result.legacyAcceptedTaskIds.length);
    expect(result.deltaV70).toBeCloseTo(result.proposedValue - result.legacyValue, 12);
  });

  it("reports paired bootstrap uncertainty without an LCB success gate", () => {
    const comparison = matchedBudgetDeltaV70(Array.from({ length: 10 }, (_, index) => ({
      taskId: `t${index}`, thetaFixed4: index / 10, proposedScore: index, legacyScore: -index,
    })));
    const first = pairedTaskClusterBootstrapDeltaV70(comparison, { replicates: 2_000, seed: "fixed" });
    const second = pairedTaskClusterBootstrapDeltaV70(comparison, { replicates: 2_000, seed: "fixed" });
    expect(first).toEqual(second);
    expect(first.role).toBe("UNCERTAINTY_REPORT_ONLY");
    expect(first.successGate).toBe(false);
  });

  it("enforces the global CNY100 cap and spend-only N ladder", () => {
    const ledger: EvoBudgetLedger = {
      schemaVersion: "direction-a.evo-engineering-budget100-ledger.v1",
      decisionId: "EVO_ENGINEERING_FIRST_BUDGET100_V1_2026_09_12",
      hardCapCny: 100,
      observedNewSpendCny: 15,
      failClosedUnknownUsageReserveCny: 2,
      activeReservationsCny: 0,
    };
    expect(() => assertDispatchAffordable(ledger, 83)).not.toThrow();
    expect(() => assertDispatchAffordable(ledger, 84)).toThrow("EVO_BUDGET100_GLOBAL_CAP_BREACH");
    expect(chooseLargestAffordableFreshN({ ledger, freshP95ReservationCnyByN: { 9: 90, 8: 79, 7: 70, 6: 60 } })).toBe(8);
    expect(chooseLargestAffordableFreshN({ ledger: { ...ledger, observedNewSpendCny: 45 }, freshP95ReservationCnyByN: { 9: 90, 8: 79, 7: 70, 6: 60 } }))
      .toBe("CORE_DECISION_REQUIRED_EVO_BUDGET100_FRESH_N");
  });
});
