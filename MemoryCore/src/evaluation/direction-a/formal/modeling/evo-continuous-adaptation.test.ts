import { describe, expect, it } from "vitest";
import {
  clusterWeightedMetrics,
  fitEvoContinuousModel,
  predictEvoContinuousModel,
  runTaskClusterNestedEvaluation,
  scoreFrozenSource,
  type EvoContinuousRow,
  type FrozenSourceModel,
} from "./evo-continuous-adaptation.js";

const shared = ["x"];
const process = ["edit", "test", "recovery"];

function row(cluster: string, index: number, theta: number, sourceScore: number, x = theta): EvoContinuousRow {
  return {
    causalGroupId: `${cluster}:g${index}`,
    statisticalClusterId: cluster,
    thetaHatFixed4: theta,
    sourceScore,
    sharedFeatures: { x },
    processFeatures: { edit: x, test: x * x, recovery: Math.max(0, -x) },
  };
}

function projectRows(kind: "ALIGNED" | "SHIFT" | "NEGATIVE" | "SCALE" | "NO_SIGNAL" = "ALIGNED"): EvoContinuousRow[] {
  return Array.from({ length: 7 }, (_, clusterIndex) => {
    const x = (clusterIndex - 3) / 4;
    const theta = kind === "NO_SIGNAL" ? 0 : x;
    const sourceScore = kind === "NEGATIVE" ? -x : kind === "SCALE" ? Math.max(-1, Math.min(1, x * 0.2)) : kind === "SHIFT" ? x - 0.1 : x;
    return [row(`task-${clusterIndex}`, 1, theta, sourceScore, x)];
  }).flat();
}

describe("Evo continuous target adaptation", () => {
  it("scores the immutable source model without refitting it", () => {
    const model: FrozenSourceModel = { contentHash: "frozen", featureOrder: ["a", "b"], means: [1, 2], scales: [2, 4], coefficients: [0.1, 0.2, -0.4], clip: [-1, 1] };
    const before = JSON.stringify(model);
    expect(scoreFrozenSource(model, { a: 3, b: 6 })).toBeCloseTo(-0.1);
    expect(JSON.stringify(model)).toBe(before);
  });

  it("A uses the frozen source prediction only as an immutable offset and learns a residual", () => {
    const rows = projectRows("SHIFT");
    const model = fitEvoContinuousModel(rows, { candidateId: "A_FROZEN_SOURCE_RESIDUAL_RIDGE", featureBlock: "EVO_SHARED_ONLY", lambda: 100,
      sharedFeatureIds: shared, processFeatureIds: process });
    expect(model.sourceOffsetCoefficient).toBe(1);
    expect(model.sourceRepresentationColumn).toBe(false);
    expect(model.rawSourceTargetPooling).toBe(false);
    expect(predictEvoContinuousModel(model, rows[3])).toBeCloseTo(rows[3].thetaHatFixed4, 2);
  });

  it("B has a separate target-scale head and never raw-pools source and target effects", () => {
    const rows = projectRows("SCALE");
    const model = fitEvoContinuousModel(rows, { candidateId: "B_SEPARATE_SCALE_PARTIAL_POOLING", featureBlock: "EVO_SHARED_PLUS_PROCESS", lambda: 10,
      sharedFeatureIds: shared, processFeatureIds: process });
    expect(model.featureOrder[0]).toBe("__FROZEN_SOURCE_REPRESENTATION__");
    expect(model.targetScaleSeparateFromSource).toBe(true);
    expect(model.rawSourceTargetPooling).toBe(false);
  });

  it("C can beat transfer under a negative-transfer relation", () => {
    const rows = projectRows("NEGATIVE");
    const config = { featureBlock: "EVO_SHARED_ONLY" as const, lambda: 1, sharedFeatureIds: shared, processFeatureIds: process };
    const a = fitEvoContinuousModel(rows, { ...config, candidateId: "A_FROZEN_SOURCE_RESIDUAL_RIDGE" });
    const c = fitEvoContinuousModel(rows, { ...config, candidateId: "C_EVO_ONLY_RIDGE" });
    const predictions = (model: typeof a) => rows.map((item) => ({ causalGroupId: item.causalGroupId, statisticalClusterId: item.statisticalClusterId,
      thetaHatFixed4: item.thetaHatFixed4, score: predictEvoContinuousModel(model, item) }));
    expect(clusterWeightedMetrics(predictions(c)).rmse).toBeLessThan(clusterWeightedMetrics(predictions(a)).rmse);
  });

  it("weights complete tasks equally when tasks contribute unequal group counts", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, index) => row("task-many", index, 1, 0, 0)),
      row("task-one", 1, -1, 0, 0),
    ];
    const model = fitEvoContinuousModel(rows, { candidateId: "C_EVO_ONLY_RIDGE", featureBlock: "EVO_SHARED_ONLY", lambda: 10,
      sharedFeatureIds: shared, processFeatureIds: process });
    expect(model.coefficients[0]).toBeCloseTo(0, 10);
    expect(model.fitClusterCount).toBe(2);
    expect(model.fitGroupCount).toBe(6);
    expect(model.groupRowsTreatedAsIid).toBe(false);
  });

  it("uses leave-one-task-cluster-out nested evaluation without held-target leakage", () => {
    const rows = projectRows("ALIGNED");
    const input = { rows, candidateId: "C_EVO_ONLY_RIDGE" as const, sharedFeatureIds: shared, processFeatureIds: process,
      lambdas: [1, 10], featureBlocks: ["EVO_SHARED_ONLY", "EVO_SHARED_PLUS_PROCESS"] as const };
    const first = runTaskClusterNestedEvaluation(input);
    const changed = rows.map((item) => item.statisticalClusterId === "task-0" ? { ...item, thetaHatFixed4: -item.thetaHatFixed4 } : item);
    const second = runTaskClusterNestedEvaluation({ ...input, rows: changed });
    const p1 = first.predictions.find((item) => item.statisticalClusterId === "task-0")!;
    const p2 = second.predictions.find((item) => item.statisticalClusterId === "task-0")!;
    expect(p1.score).toBeCloseTo(p2.score, 12);
    expect(first.folds).toHaveLength(7);
    expect(first.folds.every((fold) => fold.predictions.every((item) => item.statisticalClusterId === fold.outerClusterId))).toBe(true);
  });

  it("remains numerically valid in no-signal and small-cluster scenarios", () => {
    const rows = projectRows("NO_SIGNAL").slice(0, 4);
    const result = runTaskClusterNestedEvaluation({ rows, candidateId: "C_EVO_ONLY_RIDGE", sharedFeatureIds: shared, processFeatureIds: process,
      lambdas: [10, 100], featureBlocks: ["EVO_SHARED_ONLY"] });
    expect(result.metrics.rmse).toBeCloseTo(0, 12);
    expect(result.metrics.spearmanClusterMean).toBeNull();
    expect(result.developmentCurve).toHaveLength(9);
  });
});
