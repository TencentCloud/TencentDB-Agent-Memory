import { hashCanonical, immutableCopy } from "../core/canonical.js";

export const EVO_CONTINUOUS_ADAPTATION_VERSION = "direction-a.evo-continuous-adaptation.v1" as const;

export type EvoCandidateId = "A_FROZEN_SOURCE_RESIDUAL_RIDGE" | "B_SEPARATE_SCALE_PARTIAL_POOLING" | "C_EVO_ONLY_RIDGE";
export type EvoFeatureBlock = "EVO_SHARED_ONLY" | "EVO_SHARED_PLUS_PROCESS";

export interface FrozenSourceModel {
  readonly contentHash: string;
  readonly featureOrder: readonly string[];
  readonly means: readonly number[];
  readonly scales: readonly number[];
  readonly coefficients: readonly number[];
  readonly clip: readonly [number, number];
}

export interface EvoContinuousRow {
  readonly causalGroupId: string;
  readonly statisticalClusterId: string;
  readonly thetaHatFixed4: number;
  readonly sourceScore: number;
  readonly sharedFeatures: Readonly<Record<string, number>>;
  readonly processFeatures: Readonly<Record<string, number>>;
}

export interface EvoContinuousConfig {
  readonly candidateId: EvoCandidateId;
  readonly featureBlock: EvoFeatureBlock;
  readonly lambda: number;
  readonly sharedFeatureIds: readonly string[];
  readonly processFeatureIds: readonly string[];
}

export interface FittedEvoContinuousModel {
  readonly schemaVersion: typeof EVO_CONTINUOUS_ADAPTATION_VERSION;
  readonly candidateId: EvoCandidateId;
  readonly featureBlock: EvoFeatureBlock;
  readonly lambda: number;
  readonly featureOrder: readonly string[];
  readonly means: readonly number[];
  readonly scales: readonly number[];
  readonly coefficients: readonly number[];
  readonly sourceOffsetCoefficient: 0 | 1;
  readonly sourceRepresentationColumn: boolean;
  readonly targetScaleSeparateFromSource: true;
  readonly rawSourceTargetPooling: false;
  readonly groupRowsTreatedAsIid: false;
  readonly fitClusterCount: number;
  readonly fitGroupCount: number;
  readonly trainingHash: string;
}

export interface ContinuousPrediction {
  readonly causalGroupId: string;
  readonly statisticalClusterId: string;
  readonly thetaHatFixed4: number;
  readonly score: number;
  readonly outerClusterId?: string;
  readonly selectedLambda?: number;
  readonly selectedFeatureBlock?: EvoFeatureBlock;
}

export interface ClusterWeightedMetrics {
  readonly independentClusters: number;
  readonly groups: number;
  readonly rmse: number;
  readonly mae: number;
  readonly spearmanClusterMean: number | null;
  readonly signAccuracy: number;
}

export interface DevelopmentCurveRow {
  readonly targetCoverage: number;
  readonly achievedCoverage: number;
  readonly acceptedGroups: number;
  readonly acceptedClusters: number;
  readonly V: number;
  readonly G: number;
  readonly acceptedMeanTheta: number | null;
}

export interface NestedOuterFoldResult {
  readonly outerClusterId: string;
  readonly selectedLambda: number;
  readonly selectedFeatureBlock: EvoFeatureBlock;
  readonly innerMetrics: ClusterWeightedMetrics;
  readonly outerMetrics: ClusterWeightedMetrics;
  readonly predictions: readonly ContinuousPrediction[];
  readonly modelHash: string;
}

export interface NestedCandidateResult {
  readonly schemaVersion: typeof EVO_CONTINUOUS_ADAPTATION_VERSION;
  readonly candidateId: EvoCandidateId;
  readonly folds: readonly NestedOuterFoldResult[];
  readonly predictions: readonly ContinuousPrediction[];
  readonly metrics: ClusterWeightedMetrics;
  readonly developmentCurve: readonly DevelopmentCurveRow[];
  readonly contentHash: string;
}

function assertRow(row: EvoContinuousRow): void {
  if (!row.causalGroupId || !row.statisticalClusterId) throw new Error("EVO_CONTINUOUS_IDENTITY_REQUIRED");
  if (![row.thetaHatFixed4, row.sourceScore].every(Number.isFinite)) throw new Error("EVO_CONTINUOUS_TARGET_OR_SOURCE_SCORE_INVALID");
  if (row.thetaHatFixed4 < -1 || row.thetaHatFixed4 > 1) throw new Error("EVO_CONTINUOUS_FIXED4_OUT_OF_RANGE");
  for (const [id, value] of [...Object.entries(row.sharedFeatures), ...Object.entries(row.processFeatures)]) {
    if (!id || !Number.isFinite(value)) throw new Error(`EVO_CONTINUOUS_FEATURE_INVALID:${id}`);
  }
}

function assertRows(rows: readonly EvoContinuousRow[]): void {
  if (!rows.length) throw new Error("EVO_CONTINUOUS_ROWS_REQUIRED");
  rows.forEach(assertRow);
  if (new Set(rows.map((row) => row.causalGroupId)).size !== rows.length) throw new Error("EVO_CONTINUOUS_DUPLICATE_GROUP");
}

export function scoreFrozenSource(model: FrozenSourceModel, features: Readonly<Record<string, number>>): number {
  if (model.featureOrder.length !== model.means.length || model.featureOrder.length !== model.scales.length
    || model.coefficients.length !== model.featureOrder.length + 1) throw new Error("FROZEN_SOURCE_MODEL_SHAPE_INVALID");
  const raw = model.coefficients[0] + model.featureOrder.reduce((sum, featureId, index) => {
    const value = features[featureId];
    if (!Number.isFinite(value) || !(model.scales[index] > 0)) throw new Error(`FROZEN_SOURCE_FEATURE_INVALID:${featureId}`);
    return sum + model.coefficients[index + 1] * (value - model.means[index]) / model.scales[index];
  }, 0);
  return Math.max(model.clip[0], Math.min(model.clip[1], raw));
}

function clusterWeights(rows: readonly EvoContinuousRow[]): number[] {
  const clusters = [...new Set(rows.map((row) => row.statisticalClusterId))];
  const counts = new Map(clusters.map((clusterId) => [clusterId, rows.filter((row) => row.statisticalClusterId === clusterId).length]));
  return rows.map((row) => 1 / clusters.length / counts.get(row.statisticalClusterId)!);
}

function featuresFor(row: EvoContinuousRow, config: EvoContinuousConfig): number[] {
  const shared = config.sharedFeatureIds.map((id) => {
    const value = row.sharedFeatures[id];
    if (!Number.isFinite(value)) throw new Error(`EVO_SHARED_FEATURE_MISSING:${id}:${row.causalGroupId}`);
    return value;
  });
  const process = config.featureBlock === "EVO_SHARED_PLUS_PROCESS" ? config.processFeatureIds.map((id) => {
    const value = row.processFeatures[id];
    if (!Number.isFinite(value)) throw new Error(`EVO_PROCESS_FEATURE_MISSING:${id}:${row.causalGroupId}`);
    return value;
  }) : [];
  return [...shared, ...process];
}

function solve(matrix: number[][], vector: number[]): number[] {
  const n = vector.length;
  const augmented = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) if (Math.abs(augmented[row][col]) > Math.abs(augmented[pivot][col])) pivot = row;
    [augmented[col], augmented[pivot]] = [augmented[pivot], augmented[col]];
    if (Math.abs(augmented[col][col]) < 1e-12) augmented[col][col] += 1e-8;
    const divisor = augmented[col][col];
    for (let j = col; j <= n; j += 1) augmented[col][j] /= divisor;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = augmented[row][col];
      for (let j = col; j <= n; j += 1) augmented[row][j] -= factor * augmented[col][j];
    }
  }
  return augmented.map((row) => row[n]);
}

function featureOrder(config: EvoContinuousConfig): string[] {
  const target = [...config.sharedFeatureIds, ...(config.featureBlock === "EVO_SHARED_PLUS_PROCESS" ? config.processFeatureIds : [])];
  return config.candidateId === "B_SEPARATE_SCALE_PARTIAL_POOLING" ? ["__FROZEN_SOURCE_REPRESENTATION__", ...target] : target;
}

export function fitEvoContinuousModel(rows: readonly EvoContinuousRow[], config: EvoContinuousConfig): FittedEvoContinuousModel {
  assertRows(rows);
  if (!(config.lambda > 0) || !Number.isFinite(config.lambda)) throw new Error("EVO_CONTINUOUS_POSITIVE_LAMBDA_REQUIRED");
  if (!config.sharedFeatureIds.length) throw new Error("EVO_CONTINUOUS_SHARED_FEATURES_REQUIRED");
  const base = rows.map((row) => featuresFor(row, config));
  const inputs = config.candidateId === "B_SEPARATE_SCALE_PARTIAL_POOLING"
    ? rows.map((row, i) => [row.sourceScore, ...base[i]]) : base;
  const targets = rows.map((row) => config.candidateId === "A_FROZEN_SOURCE_RESIDUAL_RIDGE"
    ? row.thetaHatFixed4 - row.sourceScore : row.thetaHatFixed4);
  const weights = clusterWeights(rows);
  const width = inputs[0].length;
  const means = Array.from({ length: width }, (_, col) => inputs.reduce((sum, row, i) => sum + weights[i] * row[col], 0));
  const scales = means.map((mean, col) => {
    const variance = inputs.reduce((sum, row, i) => sum + weights[i] * (row[col] - mean) ** 2, 0);
    return variance > 1e-12 ? Math.sqrt(variance) : 1;
  });
  const standardized = inputs.map((row) => [1, ...row.map((value, col) => (value - means[col]) / scales[col])]);
  const size = width + 1;
  const gram = Array.from({ length: size }, () => Array(size).fill(0) as number[]);
  const rhs = Array(size).fill(0) as number[];
  standardized.forEach((vector, rowIndex) => {
    for (let left = 0; left < size; left += 1) {
      rhs[left] += weights[rowIndex] * vector[left] * targets[rowIndex];
      for (let right = 0; right < size; right += 1) gram[left][right] += weights[rowIndex] * vector[left] * vector[right];
    }
  });
  for (let index = 1; index < size; index += 1) gram[index][index] += config.lambda;
  const coefficients = solve(gram, rhs);
  const body = {
    schemaVersion: EVO_CONTINUOUS_ADAPTATION_VERSION,
    candidateId: config.candidateId,
    featureBlock: config.featureBlock,
    lambda: config.lambda,
    featureOrder: featureOrder(config),
    means,
    scales,
    coefficients,
    sourceOffsetCoefficient: (config.candidateId === "A_FROZEN_SOURCE_RESIDUAL_RIDGE" ? 1 : 0) as 0 | 1,
    sourceRepresentationColumn: config.candidateId === "B_SEPARATE_SCALE_PARTIAL_POOLING",
    targetScaleSeparateFromSource: true as const,
    rawSourceTargetPooling: false as const,
    groupRowsTreatedAsIid: false as const,
    fitClusterCount: new Set(rows.map((row) => row.statisticalClusterId)).size,
    fitGroupCount: rows.length,
  };
  return immutableCopy({ ...body, trainingHash: hashCanonical({ ...body, rows }) }) as FittedEvoContinuousModel;
}

export function predictEvoContinuousModel(model: FittedEvoContinuousModel, row: EvoContinuousRow): number {
  assertRow(row);
  const targetFeatureIds = model.featureOrder.filter((id) => id !== "__FROZEN_SOURCE_REPRESENTATION__");
  const values = [
    ...(model.sourceRepresentationColumn ? [row.sourceScore] : []),
    ...targetFeatureIds.map((id) => row.sharedFeatures[id] ?? row.processFeatures[id]),
  ];
  if (values.some((value) => !Number.isFinite(value)) || values.length !== model.means.length) throw new Error("EVO_CONTINUOUS_PREDICTION_FEATURE_MISMATCH");
  const fitted = model.coefficients[0] + values.reduce((sum, value, index) => sum + model.coefficients[index + 1] * (value - model.means[index]) / model.scales[index], 0);
  return Math.max(-1, Math.min(1, model.sourceOffsetCoefficient * row.sourceScore + fitted));
}

function mean(values: readonly number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length; }

function ranks(values: readonly number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index);
  const result = Array(values.length).fill(0) as number[];
  for (let start = 0; start < indexed.length;) {
    let end = start + 1;
    while (end < indexed.length && indexed[end].value === indexed[start].value) end += 1;
    const rank = (start + end - 1) / 2 + 1;
    for (let i = start; i < end; i += 1) result[indexed[i].index] = rank;
    start = end;
  }
  return result;
}

function correlation(left: readonly number[], right: readonly number[]): number | null {
  if (left.length < 2 || left.length !== right.length) return null;
  const lm = mean(left); const rm = mean(right);
  const numerator = left.reduce((sum, value, i) => sum + (value - lm) * (right[i] - rm), 0);
  const ld = Math.sqrt(left.reduce((sum, value) => sum + (value - lm) ** 2, 0));
  const rd = Math.sqrt(right.reduce((sum, value) => sum + (value - rm) ** 2, 0));
  return ld > 0 && rd > 0 ? numerator / (ld * rd) : null;
}

export function clusterWeightedMetrics(predictions: readonly ContinuousPrediction[]): ClusterWeightedMetrics {
  if (!predictions.length) throw new Error("EVO_CONTINUOUS_PREDICTIONS_REQUIRED");
  const clusters = [...new Set(predictions.map((row) => row.statisticalClusterId))].sort();
  const clusterSummaries = clusters.map((clusterId) => {
    const rows = predictions.filter((row) => row.statisticalClusterId === clusterId);
    const errors = rows.map((row) => row.score - row.thetaHatFixed4);
    return {
      prediction: mean(rows.map((row) => row.score)), target: mean(rows.map((row) => row.thetaHatFixed4)),
      mse: mean(errors.map((value) => value ** 2)), mae: mean(errors.map(Math.abs)),
      sign: mean(rows.map((row) => Number(Math.sign(row.score) === Math.sign(row.thetaHatFixed4)))),
    };
  });
  return {
    independentClusters: clusters.length,
    groups: predictions.length,
    rmse: Math.sqrt(mean(clusterSummaries.map((row) => row.mse))),
    mae: mean(clusterSummaries.map((row) => row.mae)),
    spearmanClusterMean: correlation(ranks(clusterSummaries.map((row) => row.prediction)), ranks(clusterSummaries.map((row) => row.target))),
    signAccuracy: mean(clusterSummaries.map((row) => row.sign)),
  };
}

export function developmentCurve(predictions: readonly ContinuousPrediction[], targetCoverages: readonly number[] = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]): DevelopmentCurveRow[] {
  const clusters = [...new Set(predictions.map((row) => row.statisticalClusterId))];
  const clusterCounts = new Map(clusters.map((id) => [id, predictions.filter((row) => row.statisticalClusterId === id).length]));
  const weighted = predictions.map((row) => ({ ...row, weight: 1 / clusters.length / clusterCounts.get(row.statisticalClusterId)! }))
    .sort((a, b) => b.score - a.score || a.causalGroupId.localeCompare(b.causalGroupId));
  const populationMean = weighted.reduce((sum, row) => sum + row.weight * row.thetaHatFixed4, 0);
  return targetCoverages.map((targetCoverage) => {
    let cumulative = 0;
    const accepted = weighted.filter((row) => {
      if (cumulative >= targetCoverage - 1e-12) return false;
      cumulative += row.weight;
      return true;
    });
    const V = accepted.reduce((sum, row) => sum + row.weight * row.thetaHatFixed4, 0);
    const G = accepted.reduce((sum, row) => sum + row.weight * (row.thetaHatFixed4 - populationMean), 0);
    return { targetCoverage, achievedCoverage: cumulative, acceptedGroups: accepted.length,
      acceptedClusters: new Set(accepted.map((row) => row.statisticalClusterId)).size, V, G,
      acceptedMeanTheta: cumulative > 0 ? V / cumulative : null };
  });
}

function candidateConfig(base: Omit<EvoContinuousConfig, "featureBlock" | "lambda">, featureBlock: EvoFeatureBlock, lambda: number): EvoContinuousConfig {
  return { ...base, featureBlock, lambda };
}

function tuneOnClusters(rows: readonly EvoContinuousRow[], base: Omit<EvoContinuousConfig, "featureBlock" | "lambda">,
  lambdas: readonly number[], blocks: readonly EvoFeatureBlock[]): { config: EvoContinuousConfig; metrics: ClusterWeightedMetrics } {
  const clusters = [...new Set(rows.map((row) => row.statisticalClusterId))].sort();
  if (clusters.length < 3) throw new Error("EVO_CONTINUOUS_INNER_CLUSTER_COUNT_INSUFFICIENT");
  const evaluated = blocks.flatMap((block) => lambdas.map((lambda) => {
    const predictions = clusters.flatMap((held) => {
      const train = rows.filter((row) => row.statisticalClusterId !== held);
      const validation = rows.filter((row) => row.statisticalClusterId === held);
      const config = candidateConfig(base, block, lambda);
      const model = fitEvoContinuousModel(train, config);
      return validation.map((row) => ({ causalGroupId: row.causalGroupId, statisticalClusterId: row.statisticalClusterId,
        thetaHatFixed4: row.thetaHatFixed4, score: predictEvoContinuousModel(model, row) }));
    });
    return { config: candidateConfig(base, block, lambda), metrics: clusterWeightedMetrics(predictions) };
  }));
  evaluated.sort((a, b) => a.metrics.rmse - b.metrics.rmse || a.metrics.mae - b.metrics.mae
    || b.config.lambda - a.config.lambda || a.config.featureBlock.localeCompare(b.config.featureBlock));
  return evaluated[0];
}

export function runTaskClusterNestedEvaluation(input: {
  readonly rows: readonly EvoContinuousRow[];
  readonly candidateId: EvoCandidateId;
  readonly sharedFeatureIds: readonly string[];
  readonly processFeatureIds: readonly string[];
  readonly lambdas: readonly number[];
  readonly featureBlocks: readonly EvoFeatureBlock[];
  readonly curveCoverages?: readonly number[];
}): NestedCandidateResult {
  assertRows(input.rows);
  const clusters = [...new Set(input.rows.map((row) => row.statisticalClusterId))].sort();
  if (clusters.length < 4) throw new Error("EVO_CONTINUOUS_OUTER_CLUSTER_COUNT_INSUFFICIENT");
  if (!input.lambdas.length || input.lambdas.some((value) => !(value > 0))) throw new Error("EVO_CONTINUOUS_LAMBDA_GRID_INVALID");
  const base = { candidateId: input.candidateId, sharedFeatureIds: input.sharedFeatureIds, processFeatureIds: input.processFeatureIds };
  const folds = clusters.map((outerClusterId): NestedOuterFoldResult => {
    const outerTrain = input.rows.filter((row) => row.statisticalClusterId !== outerClusterId);
    const outerTest = input.rows.filter((row) => row.statisticalClusterId === outerClusterId);
    const selected = tuneOnClusters(outerTrain, base, input.lambdas, input.featureBlocks);
    const model = fitEvoContinuousModel(outerTrain, selected.config);
    const predictions = outerTest.map((row) => ({ causalGroupId: row.causalGroupId, statisticalClusterId: row.statisticalClusterId,
      thetaHatFixed4: row.thetaHatFixed4, score: predictEvoContinuousModel(model, row), outerClusterId,
      selectedLambda: selected.config.lambda, selectedFeatureBlock: selected.config.featureBlock }));
    return { outerClusterId, selectedLambda: selected.config.lambda, selectedFeatureBlock: selected.config.featureBlock,
      innerMetrics: selected.metrics, outerMetrics: clusterWeightedMetrics(predictions), predictions, modelHash: model.trainingHash };
  });
  const predictions = folds.flatMap((fold) => fold.predictions);
  const body = { schemaVersion: EVO_CONTINUOUS_ADAPTATION_VERSION, candidateId: input.candidateId, folds, predictions,
    metrics: clusterWeightedMetrics(predictions), developmentCurve: developmentCurve(predictions, input.curveCoverages) };
  return immutableCopy({ ...body, contentHash: hashCanonical(body) }) as NestedCandidateResult;
}

export function fitFinalCandidateFromNested(rows: readonly EvoContinuousRow[], nested: NestedCandidateResult,
  sharedFeatureIds: readonly string[], processFeatureIds: readonly string[]): FittedEvoContinuousModel {
  const selected = [...nested.folds].sort((a, b) => {
    const ac = nested.folds.filter((fold) => fold.selectedFeatureBlock === a.selectedFeatureBlock && fold.selectedLambda === a.selectedLambda).length;
    const bc = nested.folds.filter((fold) => fold.selectedFeatureBlock === b.selectedFeatureBlock && fold.selectedLambda === b.selectedLambda).length;
    return bc - ac || b.selectedLambda - a.selectedLambda || a.selectedFeatureBlock.localeCompare(b.selectedFeatureBlock);
  })[0];
  return fitEvoContinuousModel(rows, { candidateId: nested.candidateId, featureBlock: selected.selectedFeatureBlock,
    lambda: selected.selectedLambda, sharedFeatureIds, processFeatureIds });
}

export function summarizeOuterDirectionalStability(left: NestedCandidateResult, right: NestedCandidateResult): {
  leftBetterRmseFolds: number; rightBetterRmseFolds: number; tiedFolds: number; comparableFolds: number;
} {
  const rightByCluster = new Map(right.folds.map((fold) => [fold.outerClusterId, fold]));
  let leftBetterRmseFolds = 0; let rightBetterRmseFolds = 0; let tiedFolds = 0;
  for (const fold of left.folds) {
    const other = rightByCluster.get(fold.outerClusterId);
    if (!other) throw new Error("EVO_CONTINUOUS_FOLD_ALIGNMENT_MISMATCH");
    const delta = fold.outerMetrics.rmse - other.outerMetrics.rmse;
    if (Math.abs(delta) <= 1e-12) tiedFolds += 1; else if (delta < 0) leftBetterRmseFolds += 1; else rightBetterRmseFolds += 1;
  }
  return { leftBetterRmseFolds, rightBetterRmseFolds, tiedFolds, comparableFolds: left.folds.length };
}
