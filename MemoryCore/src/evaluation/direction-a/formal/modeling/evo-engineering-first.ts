import { hashCanonical, immutableCopy } from "../core/canonical.js";
import {
  clusterWeightedMetrics,
  fitEvoContinuousModel,
  predictEvoContinuousModel,
  type ContinuousPrediction,
  type EvoCandidateId,
  type EvoContinuousRow,
  type EvoFeatureBlock,
  type NestedOuterFoldResult,
} from "./evo-continuous-adaptation.js";

export const EVO_ENGINEERING_FIRST_VERSION = "direction-a.evo-engineering-first.v1" as const;
export const EVO_ENGINEERING_DECISION_ID = "EVO_ENGINEERING_FIRST_BUDGET100_V1_2026_09_12" as const;
export const EVO_HEADLINE_COVERAGE = 0.70 as const;
export const EVO_PRIORITY_COVERAGES = [0.40, 0.60, 0.70, 0.80] as const;
export const EVO_FRESH_N_LADDER = [9, 8, 7, 6] as const;
export const EVO_GLOBAL_NEW_SPEND_CAP_CNY = 100 as const;

export interface EngineeringGuardrails {
  readonly maximumRmse: number;
  readonly maximumMae: number;
}

export const EVO_ENGINEERING_GUARDRAILS: EngineeringGuardrails = Object.freeze({
  maximumRmse: 0.25,
  maximumMae: 0.20,
});

export interface TaskPolicyRow {
  readonly statisticalClusterId: string;
  readonly score: number;
  readonly thetaHatFixed4: number;
}

export interface EngineeringPolicyMetrics {
  readonly independentClusters: number;
  readonly groups: number;
  readonly targetCoverage: number;
  readonly acceptedN: number;
  readonly acceptedTaskIds: readonly string[];
  readonly policyValue: number;
  readonly policyLiftOverPopulation: number;
  readonly populationMeanTheta: number;
  readonly spearman: number | null;
  readonly rmse: number;
  readonly mae: number;
  readonly errorGuardrailPass: boolean;
  readonly worstLeaveOneTaskPolicyValue: number;
}

export interface EngineeringCandidateEvaluation {
  readonly candidateId: string;
  readonly predictions: readonly ContinuousPrediction[];
  readonly complexityRank: number;
  readonly onlineCostRank: number;
}

export interface EngineeringSelectionResult {
  readonly schemaVersion: typeof EVO_ENGINEERING_FIRST_VERSION;
  readonly status: "SELECTED" | "DETERMINISTIC_FALLBACK_NO_GUARDRAIL_ELIGIBLE";
  readonly winnerId: string;
  readonly orderedCandidateIds: readonly string[];
  readonly metrics: Readonly<Record<string, EngineeringPolicyMetrics>>;
  readonly rule: readonly string[];
  readonly contentHash: string;
}

function mean(values: readonly number[]): number {
  if (!values.length) throw new Error("EVO_ENGINEERING_VALUES_REQUIRED");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ranks(values: readonly number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index);
  const result = Array(values.length).fill(0) as number[];
  for (let start = 0; start < indexed.length;) {
    let end = start + 1;
    while (end < indexed.length && indexed[end].value === indexed[start].value) end += 1;
    const rank = (start + end - 1) / 2 + 1;
    for (let index = start; index < end; index += 1) result[indexed[index].index] = rank;
    start = end;
  }
  return result;
}

function correlation(left: readonly number[], right: readonly number[]): number | null {
  if (left.length < 2 || left.length !== right.length) return null;
  const leftMean = mean(left);
  const rightMean = mean(right);
  const numerator = left.reduce((sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean), 0);
  const leftDenominator = Math.sqrt(left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0));
  const rightDenominator = Math.sqrt(right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0));
  return leftDenominator > 0 && rightDenominator > 0 ? numerator / (leftDenominator * rightDenominator) : null;
}

export function roundHalfUp(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("EVO_ENGINEERING_ROUND_INPUT_INVALID");
  return Math.floor(value + 0.5);
}

function taskRows(predictions: readonly ContinuousPrediction[]): TaskPolicyRow[] {
  if (!predictions.length) throw new Error("EVO_ENGINEERING_PREDICTIONS_REQUIRED");
  const clusters = [...new Set(predictions.map((row) => row.statisticalClusterId))].sort();
  return clusters.map((statisticalClusterId) => {
    const rows = predictions.filter((row) => row.statisticalClusterId === statisticalClusterId);
    return {
      statisticalClusterId,
      score: mean(rows.map((row) => row.score)),
      thetaHatFixed4: mean(rows.map((row) => row.thetaHatFixed4)),
    };
  });
}

function policyValue(rows: readonly TaskPolicyRow[], coverage: number): { acceptedN: number; acceptedTaskIds: string[]; value: number } {
  if (!(coverage > 0 && coverage <= 1)) throw new Error("EVO_ENGINEERING_COVERAGE_INVALID");
  const acceptedN = Math.max(1, Math.min(rows.length, roundHalfUp(coverage * rows.length)));
  const accepted = [...rows].sort((left, right) => right.score - left.score
    || left.statisticalClusterId.localeCompare(right.statisticalClusterId)).slice(0, acceptedN);
  return { acceptedN, acceptedTaskIds: accepted.map((row) => row.statisticalClusterId), value: mean(accepted.map((row) => row.thetaHatFixed4)) };
}

export function engineeringPolicyMetrics(
  predictions: readonly ContinuousPrediction[],
  coverage: number = EVO_HEADLINE_COVERAGE,
  guardrails: EngineeringGuardrails = EVO_ENGINEERING_GUARDRAILS,
): EngineeringPolicyMetrics {
  const rows = taskRows(predictions);
  const selected = policyValue(rows, coverage);
  const errors = rows.map((row) => row.score - row.thetaHatFixed4);
  const rmse = Math.sqrt(mean(errors.map((error) => error ** 2)));
  const mae = mean(errors.map(Math.abs));
  const jackknifeValues = rows.length > 2
    ? rows.map((held) => policyValue(rows.filter((row) => row.statisticalClusterId !== held.statisticalClusterId), coverage).value)
    : [selected.value];
  const populationMeanTheta = mean(rows.map((row) => row.thetaHatFixed4));
  return immutableCopy({
    independentClusters: rows.length,
    groups: predictions.length,
    targetCoverage: coverage,
    acceptedN: selected.acceptedN,
    acceptedTaskIds: selected.acceptedTaskIds,
    policyValue: selected.value,
    policyLiftOverPopulation: selected.value - populationMeanTheta,
    populationMeanTheta,
    spearman: correlation(ranks(rows.map((row) => row.score)), ranks(rows.map((row) => row.thetaHatFixed4))),
    rmse,
    mae,
    errorGuardrailPass: rmse <= guardrails.maximumRmse && mae <= guardrails.maximumMae,
    worstLeaveOneTaskPolicyValue: Math.min(...jackknifeValues),
  });
}

function compareMetric(left: number, right: number, descending = true): number {
  if (Math.abs(left - right) <= 1e-12) return 0;
  return descending ? right - left : left - right;
}

function rankCandidates(
  candidates: readonly EngineeringCandidateEvaluation[],
  metrics: Readonly<Record<string, EngineeringPolicyMetrics>>,
): EngineeringCandidateEvaluation[] {
  return [...candidates].sort((left, right) => {
    const lm = metrics[left.candidateId];
    const rm = metrics[right.candidateId];
    return compareMetric(lm.policyValue, rm.policyValue)
      || compareMetric(lm.spearman ?? Number.NEGATIVE_INFINITY, rm.spearman ?? Number.NEGATIVE_INFINITY)
      || compareMetric(lm.worstLeaveOneTaskPolicyValue, rm.worstLeaveOneTaskPolicyValue)
      || left.complexityRank - right.complexityRank
      || left.onlineCostRank - right.onlineCostRank
      || left.candidateId.localeCompare(right.candidateId);
  });
}

export function selectEngineeringCandidate(
  candidates: readonly EngineeringCandidateEvaluation[],
  options: {
    readonly coverage?: number;
    readonly guardrails?: EngineeringGuardrails;
    readonly fallbackOrder: readonly string[];
  },
): EngineeringSelectionResult {
  if (!candidates.length || new Set(candidates.map((candidate) => candidate.candidateId)).size !== candidates.length) {
    throw new Error("EVO_ENGINEERING_CANDIDATE_SET_INVALID");
  }
  const metrics = Object.fromEntries(candidates.map((candidate) => [
    candidate.candidateId,
    engineeringPolicyMetrics(candidate.predictions, options.coverage, options.guardrails),
  ]));
  const eligible = candidates.filter((candidate) => metrics[candidate.candidateId].errorGuardrailPass);
  const ordered = rankCandidates(eligible, metrics);
  const fallback = options.fallbackOrder.find((id) => candidates.some((candidate) => candidate.candidateId === id))
    ?? [...candidates].sort((left, right) => left.candidateId.localeCompare(right.candidateId))[0].candidateId;
  const body = {
    schemaVersion: EVO_ENGINEERING_FIRST_VERSION,
    status: (ordered.length ? "SELECTED" : "DETERMINISTIC_FALLBACK_NO_GUARDRAIL_ELIGIBLE") as EngineeringSelectionResult["status"],
    winnerId: ordered[0]?.candidateId ?? fallback,
    orderedCandidateIds: ordered.length ? ordered.map((candidate) => candidate.candidateId) : [fallback],
    metrics,
    rule: [
      "RMSE<=0.25_AND_MAE<=0.20_IS_A_NON_OPTIMIZING_ELIGIBILITY_GUARDRAIL",
      "MAXIMIZE_TASK_WEIGHTED_OOF_ACCEPTED_MEAN_THETA_AT_70_PERCENT",
      "MAXIMIZE_TASK_LEVEL_SPEARMAN",
      "MAXIMIZE_WORST_LEAVE_ONE_TASK_POLICY_VALUE",
      "MINIMIZE_COMPLEXITY_THEN_ONLINE_COST",
      "CANONICAL_ID_FINAL_TIE_BREAK",
    ],
  };
  return immutableCopy({ ...body, contentHash: hashCanonical(body) }) as EngineeringSelectionResult;
}

function assertEngineeringRows(rows: readonly EvoContinuousRow[]): void {
  if (new Set(rows.map((row) => row.statisticalClusterId)).size < 4) throw new Error("EVO_ENGINEERING_OUTER_CLUSTER_COUNT_INSUFFICIENT");
  if (new Set(rows.map((row) => row.causalGroupId)).size !== rows.length) throw new Error("EVO_ENGINEERING_DUPLICATE_GROUP");
}

function tuneEngineeringOnClusters(input: {
  readonly rows: readonly EvoContinuousRow[];
  readonly candidateId: EvoCandidateId;
  readonly sharedFeatureIds: readonly string[];
  readonly processFeatureIds: readonly string[];
  readonly lambdas: readonly number[];
  readonly featureBlocks: readonly EvoFeatureBlock[];
}): { featureBlock: EvoFeatureBlock; lambda: number; innerMetrics: ReturnType<typeof clusterWeightedMetrics> } {
  const clusters = [...new Set(input.rows.map((row) => row.statisticalClusterId))].sort();
  if (clusters.length < 3) throw new Error("EVO_ENGINEERING_INNER_CLUSTER_COUNT_INSUFFICIENT");
  const evaluated = input.featureBlocks.flatMap((featureBlock) => input.lambdas.map((lambda) => {
    const predictions = clusters.flatMap((held) => {
      const train = input.rows.filter((row) => row.statisticalClusterId !== held);
      const validation = input.rows.filter((row) => row.statisticalClusterId === held);
      const model = fitEvoContinuousModel(train, { candidateId: input.candidateId, featureBlock, lambda,
        sharedFeatureIds: input.sharedFeatureIds, processFeatureIds: input.processFeatureIds });
      return validation.map((row) => ({ causalGroupId: row.causalGroupId, statisticalClusterId: row.statisticalClusterId,
        thetaHatFixed4: row.thetaHatFixed4, score: predictEvoContinuousModel(model, row) }));
    });
    return {
      candidateId: `${featureBlock}:${lambda}`,
      predictions,
      complexityRank: featureBlock === "EVO_SHARED_ONLY" ? 0 : 1,
      onlineCostRank: featureBlock === "EVO_SHARED_ONLY" ? 0 : 1,
      featureBlock,
      lambda,
    };
  }));
  const fallbackOrder = [...evaluated]
    .sort((left, right) => left.complexityRank - right.complexityRank || right.lambda - left.lambda || left.candidateId.localeCompare(right.candidateId))
    .map((row) => row.candidateId);
  const selected = selectEngineeringCandidate(evaluated, { fallbackOrder });
  const config = evaluated.find((row) => row.candidateId === selected.winnerId)!;
  return { featureBlock: config.featureBlock, lambda: config.lambda, innerMetrics: clusterWeightedMetrics(config.predictions) };
}

export interface EngineeringNestedCandidateResult {
  readonly schemaVersion: typeof EVO_ENGINEERING_FIRST_VERSION;
  readonly candidateId: EvoCandidateId;
  readonly folds: readonly NestedOuterFoldResult[];
  readonly predictions: readonly ContinuousPrediction[];
  readonly metrics: EngineeringPolicyMetrics;
  readonly conventionalErrorMetrics: ReturnType<typeof clusterWeightedMetrics>;
  readonly contentHash: string;
}

export function runEngineeringTaskClusterNestedEvaluation(input: {
  readonly rows: readonly EvoContinuousRow[];
  readonly candidateId: EvoCandidateId;
  readonly sharedFeatureIds: readonly string[];
  readonly processFeatureIds: readonly string[];
  readonly lambdas: readonly number[];
  readonly featureBlocks: readonly EvoFeatureBlock[];
}): EngineeringNestedCandidateResult {
  assertEngineeringRows(input.rows);
  const clusters = [...new Set(input.rows.map((row) => row.statisticalClusterId))].sort();
  const folds = clusters.map((outerClusterId): NestedOuterFoldResult => {
    const outerTrain = input.rows.filter((row) => row.statisticalClusterId !== outerClusterId);
    const outerTest = input.rows.filter((row) => row.statisticalClusterId === outerClusterId);
    const selected = tuneEngineeringOnClusters({ ...input, rows: outerTrain });
    const model = fitEvoContinuousModel(outerTrain, { candidateId: input.candidateId, featureBlock: selected.featureBlock,
      lambda: selected.lambda, sharedFeatureIds: input.sharedFeatureIds, processFeatureIds: input.processFeatureIds });
    const predictions = outerTest.map((row) => ({ causalGroupId: row.causalGroupId, statisticalClusterId: row.statisticalClusterId,
      thetaHatFixed4: row.thetaHatFixed4, score: predictEvoContinuousModel(model, row), outerClusterId,
      selectedLambda: selected.lambda, selectedFeatureBlock: selected.featureBlock }));
    return { outerClusterId, selectedLambda: selected.lambda, selectedFeatureBlock: selected.featureBlock,
      innerMetrics: selected.innerMetrics, outerMetrics: clusterWeightedMetrics(predictions),
      predictions, modelHash: model.trainingHash };
  });
  const predictions = folds.flatMap((fold) => fold.predictions);
  const body = {
    schemaVersion: EVO_ENGINEERING_FIRST_VERSION,
    candidateId: input.candidateId,
    folds,
    predictions,
    metrics: engineeringPolicyMetrics(predictions),
    conventionalErrorMetrics: clusterWeightedMetrics(predictions),
  };
  return immutableCopy({ ...body, contentHash: hashCanonical(body) }) as EngineeringNestedCandidateResult;
}

export interface T2TriggerResult {
  readonly branch: "STABLE_FREEZE_NO_T2" | "UNSTABLE_RUN_EXACTLY_TWO_GROUP_T2";
  readonly triggerFired: boolean;
  readonly reasons: readonly string[];
  readonly winnerId: string;
  readonly independentTaskClusters: number;
  readonly winnerJackknifeSupport: number;
  readonly modalFeatureBlockSupport: number;
  readonly modalLambdaSupport: number;
  readonly noT3: true;
}

export function evaluateT2Trigger(input: {
  readonly candidates: readonly (EngineeringCandidateEvaluation & {
    readonly foldSelections: readonly { featureBlock: EvoFeatureBlock; lambda: number }[];
  })[];
  readonly expectedTaskClusters?: number;
  readonly fallbackOrder: readonly string[];
}): T2TriggerResult {
  const expected = input.expectedTaskClusters ?? 8;
  const clusters = [...new Set(input.candidates.flatMap((candidate) => candidate.predictions.map((row) => row.statisticalClusterId)))].sort();
  const selection = selectEngineeringCandidate(input.candidates, { fallbackOrder: input.fallbackOrder });
  const winner = input.candidates.find((candidate) => candidate.candidateId === selection.winnerId)!;
  const winnerRows = taskRows(winner.predictions);
  const targetLevels = new Set(winnerRows.map((row) => row.thetaHatFixed4.toFixed(12))).size;
  const nonZeroTargets = winnerRows.filter((row) => Math.abs(row.thetaHatFixed4) > 1e-12).length;
  const scoreMean = mean(winnerRows.map((row) => row.score));
  const scoreVariance = mean(winnerRows.map((row) => (row.score - scoreMean) ** 2));
  const jackknifeWinners = clusters.map((held) => selectEngineeringCandidate(input.candidates.map((candidate) => ({
    ...candidate,
    predictions: candidate.predictions.filter((row) => row.statisticalClusterId !== held),
  })), { fallbackOrder: input.fallbackOrder }).winnerId);
  const winnerJackknifeSupport = jackknifeWinners.filter((id) => id === selection.winnerId).length;
  const featureCounts = new Map<EvoFeatureBlock, number>();
  const lambdaCounts = new Map<number, number>();
  for (const fold of winner.foldSelections) {
    featureCounts.set(fold.featureBlock, (featureCounts.get(fold.featureBlock) ?? 0) + 1);
    lambdaCounts.set(fold.lambda, (lambdaCounts.get(fold.lambda) ?? 0) + 1);
  }
  const modalFeatureBlockSupport = Math.max(0, ...featureCounts.values());
  const modalLambdaSupport = Math.max(0, ...lambdaCounts.values());
  const reasons: string[] = [];
  if (clusters.length !== expected) reasons.push(`TASK_CLUSTER_COUNT_${clusters.length}_NOT_${expected}`);
  if (selection.status !== "SELECTED") reasons.push("NO_ERROR_GUARDRAIL_ELIGIBLE_CANDIDATE");
  if (targetLevels < 2 || nonZeroTargets < 2 || scoreVariance <= 1e-12) reasons.push("RANK_OR_PRIORITIZATION_SIGNAL_NON_IDENTIFIABLE");
  if (winnerJackknifeSupport < 6) reasons.push(`WINNER_JACKKNIFE_SUPPORT_${winnerJackknifeSupport}_LT_6_OF_8`);
  if (modalFeatureBlockSupport < 6) reasons.push(`FEATURE_BLOCK_MODAL_SUPPORT_${modalFeatureBlockSupport}_LT_6_OF_8`);
  if (modalLambdaSupport < 6) reasons.push(`LAMBDA_MODAL_SUPPORT_${modalLambdaSupport}_LT_6_OF_8`);
  return immutableCopy({
    branch: reasons.length ? "UNSTABLE_RUN_EXACTLY_TWO_GROUP_T2" : "STABLE_FREEZE_NO_T2",
    triggerFired: reasons.length > 0,
    reasons,
    winnerId: selection.winnerId,
    independentTaskClusters: clusters.length,
    winnerJackknifeSupport,
    modalFeatureBlockSupport,
    modalLambdaSupport,
    noT3: true as const,
  });
}

export interface MatchedBudgetTaskRow {
  readonly taskId: string;
  readonly thetaFixed4: number;
  readonly proposedScore: number;
  readonly legacyScore: number;
  readonly strongComparatorScore?: number;
}

export interface MatchedBudgetComparison {
  readonly taskCount: number;
  readonly coverage: number;
  readonly acceptedN: number;
  readonly proposedAcceptedTaskIds: readonly string[];
  readonly legacyAcceptedTaskIds: readonly string[];
  readonly proposedValue: number;
  readonly legacyValue: number;
  readonly deltaV70: number;
  readonly proposedAcceptedMeanTheta: number;
  readonly legacyAcceptedMeanTheta: number;
  readonly taskContributions: readonly { taskId: string; proposedAccepted: boolean; legacyAccepted: boolean; thetaFixed4: number; contribution: number }[];
}

function acceptedIds(rows: readonly MatchedBudgetTaskRow[], score: (row: MatchedBudgetTaskRow) => number, acceptedN: number): Set<string> {
  return new Set([...rows].sort((left, right) => score(right) - score(left) || left.taskId.localeCompare(right.taskId))
    .slice(0, acceptedN).map((row) => row.taskId));
}

export function matchedBudgetDeltaV70(rows: readonly MatchedBudgetTaskRow[], coverage = EVO_HEADLINE_COVERAGE): MatchedBudgetComparison {
  if (!rows.length || new Set(rows.map((row) => row.taskId)).size !== rows.length) throw new Error("EVO_MATCHED_BUDGET_TASKS_INVALID");
  if (rows.some((row) => ![row.thetaFixed4, row.proposedScore, row.legacyScore].every(Number.isFinite))) {
    throw new Error("EVO_MATCHED_BUDGET_VALUE_INVALID");
  }
  const acceptedN = Math.max(1, Math.min(rows.length, roundHalfUp(coverage * rows.length)));
  const proposed = acceptedIds(rows, (row) => row.proposedScore, acceptedN);
  const legacy = acceptedIds(rows, (row) => row.legacyScore, acceptedN);
  const taskContributions = rows.map((row) => {
    const proposedAccepted = proposed.has(row.taskId);
    const legacyAccepted = legacy.has(row.taskId);
    return { taskId: row.taskId, proposedAccepted, legacyAccepted, thetaFixed4: row.thetaFixed4,
      contribution: (Number(proposedAccepted) - Number(legacyAccepted)) * row.thetaFixed4 };
  });
  const proposedAcceptedRows = rows.filter((row) => proposed.has(row.taskId));
  const legacyAcceptedRows = rows.filter((row) => legacy.has(row.taskId));
  return immutableCopy({
    taskCount: rows.length,
    coverage,
    acceptedN,
    proposedAcceptedTaskIds: [...proposed].sort(),
    legacyAcceptedTaskIds: [...legacy].sort(),
    proposedValue: mean(rows.map((row) => Number(proposed.has(row.taskId)) * row.thetaFixed4)),
    legacyValue: mean(rows.map((row) => Number(legacy.has(row.taskId)) * row.thetaFixed4)),
    deltaV70: mean(taskContributions.map((row) => row.contribution)),
    proposedAcceptedMeanTheta: mean(proposedAcceptedRows.map((row) => row.thetaFixed4)),
    legacyAcceptedMeanTheta: mean(legacyAcceptedRows.map((row) => row.thetaFixed4)),
    taskContributions,
  });
}

function seededRandom(seed: string): () => number {
  let state = Number.parseInt(hashCanonical(seed).slice(0, 8), 16) >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function quantile(values: readonly number[], probability: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.min(ordered.length - 1, Math.ceil(probability * ordered.length) - 1))];
}

export function pairedTaskClusterBootstrapDeltaV70(
  comparison: MatchedBudgetComparison,
  options: { readonly replicates?: number; readonly seed: string },
): {
  readonly role: "UNCERTAINTY_REPORT_ONLY";
  readonly pointEstimate: number;
  readonly twoSided95: readonly [number, number];
  readonly oneSided95LowerBound: number;
  readonly fractionLessThanOrEqualZero: number;
  readonly replicates: number;
  readonly seed: string;
  readonly successGate: false;
} {
  const replicates = options.replicates ?? 20_000;
  if (!Number.isInteger(replicates) || replicates < 1) throw new Error("EVO_BOOTSTRAP_REPLICATES_INVALID");
  const contributions = comparison.taskContributions.map((row) => row.contribution);
  const random = seededRandom(options.seed);
  const draws = Array.from({ length: replicates }, () => mean(Array.from({ length: contributions.length }, () => contributions[Math.floor(random() * contributions.length)])));
  return immutableCopy({
    role: "UNCERTAINTY_REPORT_ONLY" as const,
    pointEstimate: comparison.deltaV70,
    twoSided95: [quantile(draws, 0.025), quantile(draws, 0.975)] as const,
    oneSided95LowerBound: quantile(draws, 0.05),
    fractionLessThanOrEqualZero: draws.filter((value) => value <= 0).length / replicates,
    replicates,
    seed: options.seed,
    successGate: false as const,
  });
}

export interface EvoBudgetLedger {
  readonly schemaVersion: "direction-a.evo-engineering-budget100-ledger.v1";
  readonly decisionId: typeof EVO_ENGINEERING_DECISION_ID;
  readonly hardCapCny: 100;
  readonly observedNewSpendCny: number;
  readonly failClosedUnknownUsageReserveCny: number;
  readonly activeReservationsCny: number;
}

export function protectedBudgetExposure(ledger: EvoBudgetLedger): number {
  return ledger.observedNewSpendCny + ledger.failClosedUnknownUsageReserveCny + ledger.activeReservationsCny;
}

export function assertDispatchAffordable(ledger: EvoBudgetLedger, newDispatchReservationCny: number): void {
  if (![ledger.observedNewSpendCny, ledger.failClosedUnknownUsageReserveCny, ledger.activeReservationsCny, newDispatchReservationCny]
    .every((value) => Number.isFinite(value) && value >= 0)) throw new Error("EVO_BUDGET100_LEDGER_VALUE_INVALID");
  if (ledger.hardCapCny !== EVO_GLOBAL_NEW_SPEND_CAP_CNY) throw new Error("EVO_BUDGET100_CAP_MISMATCH");
  if (protectedBudgetExposure(ledger) + newDispatchReservationCny > ledger.hardCapCny + 1e-12) {
    throw new Error("EVO_BUDGET100_GLOBAL_CAP_BREACH");
  }
}

export function chooseLargestAffordableFreshN(input: {
  readonly ledger: EvoBudgetLedger;
  readonly freshP95ReservationCnyByN: Readonly<Record<number, number>>;
}): number | "CORE_DECISION_REQUIRED_EVO_BUDGET100_FRESH_N" {
  for (const n of EVO_FRESH_N_LADDER) {
    const reservation = input.freshP95ReservationCnyByN[n];
    if (!Number.isFinite(reservation) || reservation < 0) throw new Error(`EVO_BUDGET100_FRESH_RESERVATION_INVALID:${n}`);
    if (protectedBudgetExposure(input.ledger) + reservation <= input.ledger.hardCapCny + 1e-12) return n;
  }
  return "CORE_DECISION_REQUIRED_EVO_BUDGET100_FRESH_N";
}
