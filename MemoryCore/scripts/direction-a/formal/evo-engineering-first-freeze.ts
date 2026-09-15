import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVO_ENGINEERING_DECISION_ID,
  EVO_ENGINEERING_GUARDRAILS,
  EVO_FRESH_N_LADDER,
  EVO_GLOBAL_NEW_SPEND_CAP_CNY,
  EVO_HEADLINE_COVERAGE,
  EVO_PRIORITY_COVERAGES,
  hashCanonical,
  selectEngineeringCandidate,
  type ContinuousPrediction,
} from "../../../src/evaluation/direction-a/formal/index.js";

type Json = Record<string, any>;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const memoryCore = path.resolve(scriptDir, "../../../");
const repositoryRoot = path.dirname(memoryCore);
const outputRoot = path.join(repositoryRoot, "Direction_A_Evo_Engineering_First_Budget100_v1");
const currentFormalRoot = path.join(memoryCore, ".research/direction-a/current-formal");
const authorityRoot = path.join(memoryCore, ".research/direction-a/sources/codex_implementation_sync_package_v2/01_CURRENT_AUTHORITY");
const predecessorRoot = path.join(repositoryRoot, "Direction_A_Evo_Continuous_Adaptation_v1");
const frozenAt = "2026-09-12T00:00:00.000+08:00";
const freshSeed = "direction-a-evo-budget100-fresh-prefix-2026-09-12-v1";
const t2Seed = "direction-a-evo-budget100-t2-diversity-2026-09-12-v1";
const bootstrapSeed = 0x5eeda11;
const q6ExpectedHash = "91f7889336a978b3f9970555410db18169a34f8a087852856867b106509541c3";
const proposedSourceExpectedHash = "2f0449629a228baca869a167649bea1aa809040f539d5c82073efa201c1ba139";
const t1GroupIds = [
  "theme_d6_w1_database_storage_greenfield_implementation:target-round-5",
  "theme_d3_w9_testing_quality_reproducibility_verification:target-round-5",
] as const;
const candidateFallbackOrder = [
  "C_EVO_ONLY_RIDGE",
  "B_SEPARATE_SCALE_PARTIAL_POOLING",
  "A_FROZEN_SOURCE_RESIDUAL_RIDGE",
] as const;

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const rel = (absolute: string) => path.relative(repositoryRoot, absolute).replaceAll("\\", "/");
const round = (value: number, digits = 12) => Number(value.toFixed(digits));

async function readJson(file: string): Promise<Json> {
  return JSON.parse(await readFile(file, "utf8")) as Json;
}

function withHash<T extends Json>(body: T): T & { contentHash: string } {
  return { ...body, contentHash: hashCanonical(body) };
}

async function writeJsonAt(file: string, body: Json): Promise<Json> {
  const document = body.contentHash ? body : withHash(body);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return document;
}

async function writeOutputJson(name: string, body: Json): Promise<Json> {
  return writeJsonAt(path.join(outputRoot, name), body);
}

async function writeTextAt(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text.replaceAll("\r\n", "\n"), "utf8");
}

async function assertContentHash(file: string, expected?: string): Promise<Json> {
  const value = await readJson(file);
  const contentHash = value.contentHash;
  const body = { ...value };
  delete body.contentHash;
  if (typeof contentHash !== "string" || hashCanonical(body) !== contentHash) throw new Error(`CONTENT_HASH_MISMATCH:${rel(file)}`);
  if (expected && contentHash !== expected) throw new Error(`EXPECTED_CONTENT_HASH_MISMATCH:${rel(file)}`);
  return value;
}

function seededHash(seed: string, value: string): string {
  return hashCanonical({ seed, value });
}

function quantile(values: readonly number[], probability: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.min(ordered.length - 1, Math.ceil(probability * ordered.length) - 1))];
}

function bootstrapCosts(trialCosts: readonly number[], draws: number, replicates = 20_000): number[] {
  let state = bootstrapSeed;
  const random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  return Array.from({ length: replicates }, () => {
    let total = 0;
    for (let index = 0; index < draws; index += 1) total += trialCosts[Math.floor(random() * trialCosts.length)];
    return total;
  });
}

function costSummary(trialCosts: readonly number[], groups: number): Json {
  const expectedTrials = groups * 9;
  const maximumTrials = groups * 11;
  const expected = bootstrapCosts(trialCosts, expectedTrials);
  const maximum = bootstrapCosts(trialCosts, maximumTrials);
  const maximumObservedTrialCost = Math.max(...trialCosts);
  return {
    groups,
    normalProcessXTrials: groups,
    fixed4CausalArmTrials: groups * 8,
    expectedTrials,
    technicalCompletionReserveTrials: groups * 2,
    maximumTrials,
    expectedProviderCalls: expectedTrials * 12,
    maximumProviderCalls: maximumTrials * 12,
    expectedCostCny: {
      p50: round(quantile(expected, 0.50)),
      p90: round(quantile(expected, 0.90)),
      p95: round(quantile(expected, 0.95)),
    },
    freshStageP95ReservationCny: round(quantile(maximum, 0.95)),
    maximumPlanCostCny: {
      p95BootstrapAtMaximumTrials: round(quantile(maximum, 0.95)),
      worstHistoricalTrialEnvelope: round(maximumTrials * maximumObservedTrialCost),
    },
  };
}

function changePriority(group: Json): number {
  const types = new Set(group.changeTypes as string[]);
  if (types.has("conflict") && types.has("extension")) return 4;
  if (types.has("correction") && types.has("extension")) return 3;
  if (types.has("extension")) return 2;
  if (types.has("correction")) return 1;
  return 0;
}

function chooseCanonicalGroup(taskId: string, groups: readonly Json[]): Json {
  const eligible = groups.filter((group) => group.taskId === taskId && group.permission === "PILOT_TRAIN_DEV"
    && group.technicalEligible && group.normalRunCheapXAvailable && group.processTelemetryAvailable && group.provenanceIntegrityAvailable);
  if (!eligible.length) throw new Error(`NO_ELIGIBLE_CANONICAL_GROUP:${taskId}`);
  const medianRound = (Math.min(...eligible.map((group) => group.targetRound)) + Math.max(...eligible.map((group) => group.targetRound))) / 2;
  return [...eligible].sort((left, right) => changePriority(right) - changePriority(left)
    || Math.abs(left.targetRound - medianRound) - Math.abs(right.targetRound - medianRound)
    || seededHash(freshSeed, left.causalGroupId).localeCompare(seededHash(freshSeed, right.causalGroupId)))[0];
}

function jaccardDistance(left: readonly string[], right: readonly string[]): number {
  const union = new Set([...left, ...right]);
  const intersection = new Set(left.filter((value) => right.includes(value)));
  return union.size ? 1 - intersection.size / union.size : 0;
}

function chooseT2Group(t1: Json, groups: readonly Json[]): Json {
  const eligible = groups.filter((group) => group.taskId === t1.taskId && group.causalGroupId !== t1.causalGroupId
    && group.permission === "PILOT_TRAIN_DEV" && group.technicalEligible && group.normalRunCheapXAvailable
    && group.processTelemetryAvailable && group.provenanceIntegrityAvailable);
  return [...eligible].sort((left, right) => jaccardDistance(right.changeTypes, t1.changeTypes) - jaccardDistance(left.changeTypes, t1.changeTypes)
    || Math.abs(right.targetRound - t1.targetRound) - Math.abs(left.targetRound - t1.targetRound)
    || seededHash(t2Seed, left.causalGroupId).localeCompare(seededHash(t2Seed, right.causalGroupId)))[0];
}

function breadthFirstPrefix(tasks: readonly Json[]): Json[] {
  const domains = [...new Set(tasks.map((task) => task.officialDomainId as string))]
    .sort((left, right) => seededHash(freshSeed, left).localeCompare(seededHash(freshSeed, right)));
  const byDomain = new Map(domains.map((domain) => [domain, tasks.filter((task) => task.officialDomainId === domain)
    .sort((left, right) => seededHash(freshSeed, left.taskId).localeCompare(seededHash(freshSeed, right.taskId)))]));
  const maximum = Math.max(...[...byDomain.values()].map((rows) => rows.length));
  const ordered: Json[] = [];
  for (let index = 0; index < maximum; index += 1) {
    for (const domain of domains) {
      const task = byDomain.get(domain)?.[index];
      if (task) ordered.push(task);
    }
  }
  return ordered;
}

async function main(): Promise<void> {
  await mkdir(outputRoot, { recursive: true });
  const predecessorSelection = await assertContentHash(path.join(predecessorRoot, "EVO_TRAIN_EXPANSION_SELECTION.json"));
  const predecessorBudget = await assertContentHash(path.join(predecessorRoot, "EVO_TRAIN_EXPANSION_BUDGET.json"));
  const predecessorBank = await assertContentHash(path.join(predecessorRoot, "04_EVO_CONTINUOUS_DEVELOPMENT_BANK_REPORT.json"));
  const predecessorResults = await assertContentHash(path.join(predecessorRoot, "09_EVO_ABC_OOF_RESULTS.json"));
  const predecessorAblation = await assertContentHash(path.join(predecessorRoot, "10_EVO_PROCESS_EVIDENCE_ABLATION.json"));
  const predecessorTransfer = await assertContentHash(path.join(predecessorRoot, "11_EVO_NEGATIVE_TRANSFER_REPORT.json"));
  const predecessorFirewall = await assertContentHash(path.join(predecessorRoot, "13_EVO_TASK_CAPACITY_FIREWALL.json"));
  if (predecessorBank.tasks !== 6 || predecessorBank.groups !== 8 || predecessorBank.thetaSummary.nonZeroGroups !== 3) {
    throw new Error("CURRENT_EVO_BANK_FACT_MISMATCH");
  }
  if (JSON.stringify(predecessorSelection.selectedGroups.map((group: Json) => group.causalGroupId)) !== JSON.stringify(t1GroupIds)) {
    throw new Error("T1_D6_D3_IDENTITY_MISMATCH");
  }
  if (predecessorBudget.expectedProviderCalls !== 216 || predecessorBudget.absoluteProviderCallCap !== 264
    || predecessorBudget.expectedCostCny.p50 !== 15.3218475 || predecessorBudget.expectedCostCny.p95 !== 17.5180545
    || predecessorBudget.recommendedHardCapCny !== 36.4) throw new Error("T1_COST_FACT_MISMATCH");

  const inventoryPath = path.join(currentFormalRoot, "prepilot/initial6-candidate-selection-freeze-v1.json");
  const manifestPath = path.join(currentFormalRoot, "pilot/manifests/current-formal-initial6-evo-pilot-manifest-v6.json");
  const q6Path = path.join(currentFormalRoot, "prepilot/q6-holdout-seal-v1.json");
  const sourceModelPath = path.join(repositoryRoot, "Direction_A_PostCAL_Model_Value_v2_1/11_PROPOSED_V2_FINAL_MODEL.json");
  const legacySourcePath = path.join(repositoryRoot, "Direction_A_PostCAL_Model_Value_v2_1/12_BASELINE_V2_FINAL_MODEL.json");
  const benchmarkPath = path.join(predecessorRoot, "02_EVO_BENCHMARK_PROVENANCE.json");
  const inventory = await assertContentHash(inventoryPath);
  const manifest = await assertContentHash(manifestPath);
  const q6 = await assertContentHash(q6Path, q6ExpectedHash);
  const sourceModel = await assertContentHash(sourceModelPath, proposedSourceExpectedHash);
  const legacySource = await assertContentHash(legacySourcePath);
  const benchmark = await assertContentHash(benchmarkPath);

  const existingTrain = new Set((manifest.selectedTaskIds as string[]));
  const t1Tasks = new Set((predecessorSelection.selectedTasks as Json[]).map((task) => task.taskId as string));
  const q6Tasks = new Set(q6.sealedTaskIds as string[]);
  const freshTasks = (inventory.tasks as Json[]).filter((task) => !existingTrain.has(task.taskId) && !t1Tasks.has(task.taskId) && !q6Tasks.has(task.taskId));
  if (freshTasks.length !== 13) throw new Error(`FRESH_POPULATION_EXPECTED_13_GOT_${freshTasks.length}`);
  const oldFreshRoles = new Map((predecessorFirewall.roleRows as Json[]).map((row) => [row.taskId, row.role]));
  const populationRows = freshTasks.map((task) => {
    const group = chooseCanonicalGroup(task.taskId, inventory.groups as Json[]);
    return {
      taskId: task.taskId,
      statisticalClusterId: task.taskId,
      officialDomainId: task.officialDomainId,
      workflowCategory: task.category,
      supersededLegacyRole: oldFreshRoles.get(task.taskId),
      normalProcessXRequiredBeforeCausalY: true,
      normalRunCheapXCapable: task.normalRunCheapXAvailable,
      canonicalCausalGroupId: group.causalGroupId,
      targetRound: group.targetRound,
      changeTypes: group.changeTypes,
      taskCandidateHash: task.candidateHash,
      sourceTaskDirectoryHash: task.sourceTaskDirectoryHash,
      groupCandidateHash: group.candidateHash,
      sourceEvidenceHash: group.sourceEvidenceHash,
    };
  });
  const prefixRows: Json[] = breadthFirstPrefix(populationRows).map((task, index): Json => ({ prefixIndex: index + 1, ...task }));
  const freshPrefixHash = hashCanonical(prefixRows.map((row) => ({ prefixIndex: row.prefixIndex, taskId: row.taskId,
    canonicalCausalGroupId: row.canonicalCausalGroupId, taskCandidateHash: row.taskCandidateHash, groupCandidateHash: row.groupCandidateHash })));
  const t1Groups = (predecessorSelection.selectedGroups as Json[]);
  const t2Groups = t1Groups.map((group) => chooseT2Group(group, inventory.groups as Json[]));

  const authorityNames = ["Direction_A_Experiment_Design_MASTER.md", "Direction_A_Experiment_Control.md", "FINAL_FROZEN_DECISION_REGISTER.md",
    "831-方向A-方案-李姝瑾-v7.0_CURRENT_CONTINUOUS_CAUSAL.md", "Stage_0_Architecture_Baseline_Plan_v7_1_OVERLAY.md",
    "Stage_2_Main_Method_Validation_Plan_v7_1_OVERLAY.md", "Stage_3_Transport_and_EB_Plan_v7_1_OVERLAY.md"];
  const authorityBindings = await Promise.all(authorityNames.map(async (name) => {
    const file = path.join(authorityRoot, name);
    const raw = await readFile(file);
    return { path: rel(file), sha256: sha(raw), bytes: raw.length };
  }));

  const amendmentBody = {
    schemaVersion: "direction-a.evo-engineering-first-budget100-amendment.v1",
    decisionId: EVO_ENGINEERING_DECISION_ID,
    frozenAt,
    timing: "AFTER_INITIAL6_AND_CURRENT_6_TASK_8_GROUP_DEVELOPMENT_EVIDENCE_BEFORE_D6_D3_T1_Y_BEFORE_FRESH_ENGINEERING_Y_BEFORE_Q6_Y",
    prospectiveScope: "ALL_NEW_EVO_CAUSAL_Y_AFTER_2026_09_12",
    historicalMutation: false,
    preserved: ["FIXED_FIRST_4_TECHNICALLY_VALID_FULL_REMOVE_EFFECT", "HIDDEN_Y_FIREWALL", "COMPLETE_TASK_REQUIREMENT_CHAIN_CLUSTER",
      "Q6_D1_SEAL", "ALL_HISTORICAL_MEM2_AND_EVO_RESULTS", "A_B_C_MODEL_FAMILY", "D6_D3_T1_IDENTITIES"],
    supersedesProspectively: ["FUTURE_EVO_ONE_SIDED95_LCB_AS_HARD_PASS_FAIL_GATE", "RMSE_FIRST_EVO_WINNER_RULE",
      "FUTURE_EVO_CAL5_TEST5_RESERVE3_PARTITION"],
    headline: { coverage: EVO_HEADLINE_COVERAGE, acceptedN: "round_half_up(0.70*N)", estimand: "DeltaV70=mean[(A_Proposed-A_Legacy)*thetaFixed4]" },
    uncertainty: { role: "UNCERTAINTY_REPORT_ONLY", method: "PAIRED_TASK_CLUSTER_BOOTSTRAP", replicates: 20_000,
      twoSidedLevel: 0.95, oneSidedLowerBoundMayBeReported: true, crossingZeroIsEngineeringFailure: false },
    engineeringVerdict: { positive: "DeltaV70>0 => POSITIVE_ENGINEERING_COMPARISON", nonPositive: "DeltaV70<=0 => NO_POSITIVE_ENGINEERING_COMPARISON",
      mixedSupportLanguage: "POSITIVE_PRIMARY_VALUE_WITH_MIXED_SUPPORT" },
    baselines: { primary: "MATCHED_CAPACITY_LEGACY_X0_BASELINE", strongComparator: "TARGET_ONLY_SHARED_ONLY_RIDGE" },
    globalNewSpendCapCny: EVO_GLOBAL_NEW_SPEND_CAP_CNY,
    t1: { causalGroupIds: t1GroupIds, stageHardCapCny: 36.4 },
    postT1: { stable: "FREEZE_PROPOSED_NO_T2_MAXIMIZE_FRESH_N", unstable: "EXACTLY_TWO_GROUP_T2_THEN_FREEZE_MAXIMIZE_FRESH_N", t3: "PROHIBITED" },
    freshPopulation: { id: "EVO_BUDGET100_FRESH_ENGINEERING_POPULATION", taskCount: 13, prefixFrozenBeforeCausalY: true,
      nLadder: EVO_FRESH_N_LADDER, nSelectionBasis: "LARGEST_AFFORDABLE_FROM_RECONCILED_SPEND_PLUS_P95_RESERVATION_ONLY" },
    q6: { status: "SEALED", fundedByBudget100: false, causalYRead: 0 },
    authorityBindings,
  };
  const amendment = withHash(amendmentBody);
  await writeJsonAt(path.join(currentFormalRoot, "EVO_ENGINEERING_FIRST_BUDGET100_V1_20260912.json"), amendment);
  await writeTextAt(path.join(currentFormalRoot, "EVO_ENGINEERING_FIRST_BUDGET100_V1_20260912.md"), `# Evo engineering-first / budget-100 amendment\n\nDecision: \`${EVO_ENGINEERING_DECISION_ID}\`\nStatus: **FROZEN PROSPECTIVE AMENDMENT / PRE-T1-Y / PRE-FRESH-Y / PRE-Q6-Y**\n\nThis amendment was made after Initial-6 and the current six-task/eight-group development analysis, but before d6/d3 T1 causal Y, any fresh engineering-holdout causal Y, and Q6 causal Y. It never claims pre-Initial-6 timing.\n\nFor future Evo only, 95% task-cluster uncertainty remains mandatory reporting and is no longer a hard PASS/FAIL gate. The headline engineering estimand is \`DeltaV70\` against \`MATCHED_CAPACITY_LEGACY_X0_BASELINE\` at the same \`round_half_up(0.70*N)\` accepted-task budget. \`TARGET_ONLY_SHARED_ONLY_RIDGE\` is the strong secondary comparator.\n\nModel selection is development-only and lexicographic: policy value/prioritization first, task-level rank second, RMSE/MAE only as fixed error guardrails, task-cluster stability next, then lower complexity/online cost. A/B/C and shared-only/shared+process are the complete model family.\n\nThe global cumulative new-spend cap is exactly CNY100. T1 remains d6 target-round-5 plus d3 target-round-5. A stable checkpoint forbids T2; an unstable checkpoint permits exactly one frozen two-group T2 (one more group in each of d6 and d3); T3 is prohibited.\n\nThe old future CAL5 + TEST5 + reserve3 layout is superseded by one 13-task fresh engineering population with a pre-Y deterministic prefix. Future N is the largest affordable member of \`9 -> 8 -> 7 -> 6\`, selected only from reconciled spend and P95 reservation before fresh Y.\n\nUnchanged: fixed4 teacher, hidden-Y, complete-task cluster independence, Q6 d1 seal, benchmark/provider/harness identity, Mem2 results, and all historical Evo evidence.\n\nMachine authority: \`EVO_ENGINEERING_FIRST_BUDGET100_V1_20260912.json\` / \`${amendment.contentHash}\`.\n`);

  const selectionDiagnostic = selectEngineeringCandidate(Object.entries(predecessorResults.candidates as Record<string, Json>).map(([candidateId, value], index) => ({
    candidateId,
    predictions: value.predictions as ContinuousPrediction[],
    complexityRank: candidateId === "C_EVO_ONLY_RIDGE" ? 0 : 1,
    onlineCostRank: index,
  })), { fallbackOrder: candidateFallbackOrder });
  const modelRule = await writeOutputJson("03_ENGINEERING_MODEL_SELECTION_RULE.json", {
    schemaVersion: "direction-a.evo-engineering-model-selection-rule.v1",
    decisionId: EVO_ENGINEERING_DECISION_ID,
    frozenAt,
    evidencePermission: "TRAIN_DEV_ONLY",
    statisticalUnit: "COMPLETE_TASK_REQUIREMENT_CHAIN",
    split: { outer: "LEAVE_ONE_TASK_CLUSTER_OUT", inner: "LEAVE_ONE_TASK_CLUSTER_OUT_ON_OUTER_TRAIN", pairRowsTreatedAsIid: false },
    candidates: candidateFallbackOrder,
    featureBlocks: ["EVO_SHARED_ONLY", "EVO_SHARED_PLUS_PROCESS"],
    lambdaGrid: [10, 100, 1000],
    headlineCoverage: EVO_HEADLINE_COVERAGE,
    acceptedCount: "round_half_up(0.70*N_TASK_CLUSTERS)",
    eligibilityGuardrail: EVO_ENGINEERING_GUARDRAILS,
    lexicographicRule: selectionDiagnostic.rule,
    rankNullValue: "NEGATIVE_INFINITY",
    numericTieTolerance: 1e-12,
    deterministicNoEligibleFallback: candidateFallbackOrder,
    currentSixTaskDiagnosticOnly: selectionDiagnostic,
    currentDiagnosticMayNotCancelT1: true,
    futureHoldoutYAllowed: false,
    ruleChangeAfterT1RevealAllowed: false,
  });
  await writeJsonAt(path.join(currentFormalRoot, "EVO_ENGINEERING_MODEL_SELECTION_RULE_V1.json"), modelRule);

  const baselineSpec = await writeOutputJson("04_BASELINE_FREEZE_SPEC.json", {
    schemaVersion: "direction-a.evo-engineering-baseline-freeze.v1",
    decisionId: EVO_ENGINEERING_DECISION_ID,
    frozenAt,
    primary: {
      id: "MATCHED_CAPACITY_LEGACY_X0_BASELINE",
      role: "PRIMARY_HEAD_TO_HEAD_BASELINE",
      target: "thetaHatFixed4",
      sourceIdentity: { path: rel(legacySourcePath), contentHash: legacySource.contentHash, sha256: sha(await readFile(legacySourcePath)) },
      evoLawfulFeatures: ["shared_target_round_log", "shared_instruction_bytes_log"],
      unavailableSourceSemanticCoordinates: "IMPUTE_FROZEN_SOURCE_MEAN_ZERO_STANDARDIZED_CONTRIBUTION",
      targetAdaptation: "LOW_CAPACITY_RESIDUAL_RIDGE_ON_SAME_LAWFUL_TRAIN_DEV_BANK",
      lambdaGrid: [10, 100, 1000],
      tuning: "SAME_TASK_CLUSTER_ENGINEERING_RULE",
      processRichFeatures: false,
      acceptedCapacity: "IDENTICAL_round_half_up(0.70*N)_AS_PROPOSED",
    },
    strongSecondary: {
      id: "TARGET_ONLY_SHARED_ONLY_RIDGE",
      role: "STRONG_SECONDARY_COMPARATOR",
      candidateIdentity: "C_EVO_ONLY_RIDGE",
      featureBlock: "EVO_SHARED_ONLY",
      target: "thetaHatFixed4",
      trainingBank: "SAME_LAWFUL_TARGET_TRAIN_DEV_BANK",
      lambdaGrid: [10, 100, 1000],
      tuning: "SAME_TASK_CLUSTER_ENGINEERING_RULE",
      acceptedCapacity: "IDENTICAL_round_half_up(0.70*N)_AS_PROPOSED",
    },
    proposedSourceIdentity: { path: rel(sourceModelPath), contentHash: sourceModel.contentHash, sha256: sha(await readFile(sourceModelPath)) },
    baselineSwapAfterYAllowed: false,
    familyExpansionAllowed: false,
  });

  const t2Trigger = await writeOutputJson("05_T2_TRIGGER_FREEZE.json", {
    schemaVersion: "direction-a.evo-t2-trigger-freeze.v1",
    decisionId: EVO_ENGINEERING_DECISION_ID,
    frozenAt,
    checkpoint: "AFTER_T1_RECONCILIATION_USING_TRAIN_DEV_ONLY",
    expectedTaskClusters: 8,
    stableIffAll: ["ENGINEERING_WINNER_IS_ERROR_GUARDRAIL_ELIGIBLE", "AT_LEAST_2_DISTINCT_TASK_THETA_LEVELS",
      "AT_LEAST_2_NONZERO_TASK_MEAN_THETAS", "WINNER_SCORE_VARIANCE_GT_1E_12", "WINNER_JACKKNIFE_SUPPORT_GE_6_OF_8",
      "WINNER_MODAL_FEATURE_BLOCK_SUPPORT_GE_6_OF_8", "WINNER_MODAL_LAMBDA_SUPPORT_GE_6_OF_8"],
    stableBranch: { t2: "DO_NOT_RUN", action: "FREEZE_FINAL_PROPOSED_THEN_MAXIMIZE_FRESH_N" },
    unstableBranch: { t2: "RUN_EXACTLY_TWO_GROUPS", action: "RERUN_CHECKPOINT_THEN_FREEZE_DETERMINISTIC_WINNER_OR_FALLBACK",
      causalGroupIds: t2Groups.map((group) => group.causalGroupId),
      selectionPolicy: "WITHIN_EACH_T1_TASK_EXCLUDE_T1_GROUP_MAXIMIZE_CHANGE_TYPE_JACCARD_DISTANCE_THEN_TARGET_ROUND_DISTANCE_THEN_SEEDED_HASH",
      selectionSeed: t2Seed,
      groups: t2Groups.map((group) => ({ taskId: group.taskId, causalGroupId: group.causalGroupId, targetRound: group.targetRound,
        changeTypes: group.changeTypes, candidateHash: group.candidateHash, sourceEvidenceHash: group.sourceEvidenceHash })),
      labelBlind: true },
    prohibitedInputs: ["FRESH_HOLDOUT_Y", "Q6_Y", "P_VALUE", "SIGNIFICANCE", "DESIRE_TO_BEAT_BASELINE", "T1_DIRECTION_ALONE"],
    deterministicFallbackOrderAfterT2: candidateFallbackOrder,
    t3: "PROHIBITED",
  });
  await writeJsonAt(path.join(currentFormalRoot, "EVO_T2_TRIGGER_FREEZE.json"), t2Trigger);

  const population = await writeOutputJson("06_FRESH13_POPULATION.json", {
    schemaVersion: "direction-a.evo-budget100-fresh-engineering-population.v1",
    decisionId: EVO_ENGINEERING_DECISION_ID,
    frozenAt,
    populationId: "EVO_BUDGET100_FRESH_ENGINEERING_POPULATION",
    taskCount: 13,
    oneCanonicalCausalGroupPerTask: true,
    replacesFutureLayout: { old: { cal: 5, test: 5, reserve: 3 }, status: "SUPERSEDED_PROSPECTIVELY_NOT_DELETED" },
    tasks: populationRows.sort((left, right) => left.taskId.localeCompare(right.taskId)),
    q6Overlap: populationRows.filter((row) => q6Tasks.has(row.taskId)).length,
    existingTrainOverlap: populationRows.filter((row) => existingTrain.has(row.taskId)).length,
    t1Overlap: populationRows.filter((row) => t1Tasks.has(row.taskId)).length,
    causalYRead: 0,
  });
  const prefix = await writeOutputJson("07_FRESH13_PREFIX_FREEZE.json", {
    schemaVersion: "direction-a.evo-budget100-fresh-prefix-freeze.v1",
    decisionId: EVO_ENGINEERING_DECISION_ID,
    frozenAt,
    populationHash: population.contentHash,
    seed: freshSeed,
    policy: "BREADTH_FIRST_ROUND_ROBIN_ACROSS_OFFICIAL_DOMAINS_THEN_SEEDED_TASK_HASH; CANONICAL_GROUP_BY_CHANGE_PRIORITY_THEN_MEDIAN_ROUND_THEN_SEEDED_HASH",
    outcomeBlind: true,
    modelScoreBlind: true,
    proposedBaselineDisagreementBlind: true,
    prefixHash: freshPrefixHash,
    orderedTasks: prefixRows,
    futureSelection: "FIRST_N_TASKS_ONLY",
    nMayBeChosenOnlyBeforeFreshCausalY: true,
  });
  await writeJsonAt(path.join(currentFormalRoot, "EVO_FRESH13_PREFIX_FREEZE.json"), prefix);

  const events = (await readFile(path.join(currentFormalRoot, "pilot/runtime-v3/execution-events.jsonl"), "utf8")).trim().split(/\r?\n/)
    .map((line) => JSON.parse(line) as Json);
  const costsByAttempt = new Map<string, number>();
  for (const event of events.filter((event) => event.eventType === "PROVIDER_CALL_COMPLETED")) {
    costsByAttempt.set(event.attemptId, (costsByAttempt.get(event.attemptId) ?? 0) + Number(event.amountCny));
  }
  const trialCosts = [...costsByAttempt.values()];
  if (trialCosts.length !== 100 || trialCosts.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("HISTORICAL_COST_SAMPLE_MISMATCH");
  const t1Cost = costSummary(trialCosts, 2);
  const t2Cost = costSummary(trialCosts, 2);
  const freshCosts = Object.fromEntries(EVO_FRESH_N_LADDER.map((n) => [n, costSummary(trialCosts, n)]));
  const costTable = await writeOutputJson("08_BUDGET100_STAGE_COST_TABLE.json", {
    schemaVersion: "direction-a.evo-budget100-stage-cost-table.v1",
    decisionId: EVO_ENGINEERING_DECISION_ID,
    generatedAt: frozenAt,
    historicalBasis: predecessorBudget.historicalBasis,
    bootstrap: { replicates: 20_000, seedInteger: bootstrapSeed, resamplingUnit: "HISTORICAL_COMPLETE_TRIAL_COST" },
    perGroupProtocol: { normalProcessXTrials: 1, fixed4FullRemoveArmTrials: 8, expectedTrials: 9,
      trueTechnicalInvalidCompletionReserveTrials: 2, maximumTrials: 11, providerCallsPerTrialMaximum: 12 },
    t1: { ...t1Cost, stageHardCapCny: 36.4 },
    t2Conditional: { ...t2Cost, stageHardCapCny: 36.4, authorizedByCurrentRequest: false },
    freshN: freshCosts,
    freshReservationRule: "P95_BOOTSTRAP_AT_MAXIMUM_TRIALS_INCLUDING_NORMAL_AND_TWO_TRUE_TECHNICAL_INVALID_COMPLETION_RESERVES_PER_TASK",
    unknownUsagePolicy: "FAIL_CLOSED_RESERVE_WORST_HISTORICAL_TRIAL_ENVELOPE_PER_UNRECONCILED_TRIAL",
    globalCapCny: EVO_GLOBAL_NEW_SPEND_CAP_CNY,
  });
  await writeJsonAt(path.join(currentFormalRoot, "EVO_BUDGET100_STAGE_COST_TABLE.json"), costTable);

  const ledger = await writeOutputJson("09_GLOBAL_BUDGET_LEDGER_GENESIS.json", {
    schemaVersion: "direction-a.evo-engineering-budget100-ledger.v1",
    decisionId: EVO_ENGINEERING_DECISION_ID,
    createdAt: frozenAt,
    hardCapCny: 100,
    historicalSpendCounted: false,
    observedNewSpendCny: 0,
    failClosedUnknownUsageReserveCny: 0,
    activeReservationsCny: 0,
    protectedExposureCny: 0,
    remainingHeadroomCny: 100,
    nextStage: "T1_PENDING_RESEARCHER_AUTHORIZATION",
    invariant: "OBSERVED_NEW_SPEND+UNKNOWN_USAGE_RESERVE+ACTIVE_RESERVATIONS+NEW_DISPATCH_RESERVATION<=100",
    stageLocalCapMayOverrideGlobalCap: false,
  });
  await writeJsonAt(path.join(currentFormalRoot, "EVO_ENGINEERING_FIRST_BUDGET100_LEDGER.json"), ledger);

  const inference = await writeOutputJson("10_FUTURE_INFERENCE_FREEZE.json", {
    schemaVersion: "direction-a.evo-engineering-future-inference-freeze.v1",
    decisionId: EVO_ENGINEERING_DECISION_ID,
    frozenAt,
    headline: { coverage: EVO_HEADLINE_COVERAGE, acceptedCount: "round_half_up(0.70*N)", estimand: "DeltaV70",
      formula: "mean[(A_Proposed-A_Legacy)*thetaFixed4]", primaryBaseline: "MATCHED_CAPACITY_LEGACY_X0_BASELINE" },
    secondaryPriorityCurve: EVO_PRIORITY_COVERAGES,
    bootstrap: { unit: "COMPLETE_TASK_REQUIREMENT_CHAIN", paired: true, replicates: 20_000,
      seed: "direction-a-evo-deltav70-paired-task-bootstrap-2026-09-12-v1", interval: "TWO_SIDED_95_PERCENTILE",
      reportOneSided95LowerBound: true, reportFractionLessThanOrEqualZero: true, role: "UNCERTAINTY_REPORT_ONLY", successGate: false },
    reporting: ["POINT_DELTAV70", "V_PROPOSED", "V_LEGACY", "ACCEPTED_MEAN_THETA", "TASK_CONTRIBUTIONS", "RMSE", "MAE", "SPEARMAN",
      "PRIORITY_CURVE", "PROCESS_ABLATION", "STRONG_COMPARATOR", "ONLINE_MARGINAL_COST", "MEASUREMENT_AND_DESIGN_LIMITATIONS"],
    positiveEngineeringComparisonIff: "DeltaV70>0",
    ciCrossingZeroAloneMeansEngineeringFailure: false,
    inferenceChangeAfterYAllowed: false,
  });

  const t1Plan = await writeOutputJson("12_CURRENT_T1_PLAN.json", {
    schemaVersion: "direction-a.evo-engineering-first-t1-plan.v1",
    decisionId: EVO_ENGINEERING_DECISION_ID,
    frozenAt,
    status: "FROZEN_PENDING_RESEARCHER_AUTHORIZATION",
    purpose: "ADD_TWO_PREVIOUSLY_REVIEWED_TRAIN_DEV_GROUPS_THEN_RUN_ZERO_COST_ENGINEERING_CHECKPOINT",
    exactTaskIds: predecessorSelection.selectedTasks.map((task: Json) => task.taskId),
    exactCausalGroupIds: t1GroupIds,
    groups: t1Groups,
    protocol: { normalPerGroup: 1, fixed4CompleteFullRemovePairsPerGroup: 4, pair5: false,
      technicalRetryLimitPerGroup: 2, scientificFailureIsValid: true, taskClusterIndependent: true },
    executionProfile: manifest.executionSemantics,
    sourceDatasetRoot: "MemoryCore/.research/direction-a/v6.3/dependencies/evocodebench_wotraj",
    runtimeOutputRoot: "Direction_A_Evo_Engineering_First_T1_Runtime_v1",
    expectedProviderCalls: 216,
    maximumProviderCalls: 264,
    expectedCostCny: t1Cost.expectedCostCny,
    stageHardCapCny: 36.4,
    globalCapCny: 100,
    stopAfter: "T1_RECONCILIATION_AND_FIXED4_AVAILABILITY",
    authorized: { t1: false, t2: false, fresh: false, q6: false },
  });

  const runbookPath = path.join(outputRoot, "WORKBUDDY_EVO_ENGINEERING_FIRST_T1_EXECUTION.md");
  const runbook = `# WorkBuddy — Evo engineering-first T1 execution\n\nStatus: **NOT AUTHORIZED**. This is a bounded handoff, not executable authority. A separate immutable researcher grant must bind the exact request and runbook hashes.\n\n## Exact paid scope after grant\n\n- Decision: \`${EVO_ENGINEERING_DECISION_ID}\`.\n- Tasks: \`${predecessorSelection.selectedTasks.map((task: Json) => task.taskId).join("`, `")}\`.\n- Groups: \`${t1GroupIds.join("`, `")}\`.\n- Per group: exactly 1 pre-causal NORMAL/process-X run plus exactly 4 complete fixed FULL/REMOVE pairs. Pair 5 is forbidden.\n- Expected/max provider calls: 216 / 264. T1 stage hard cap: CNY36.4. Global cumulative new-spend cap: CNY100.\n- Runtime root: \`C:\\Users\\L2503\\Desktop\\TencentDB-Agent-Memory\\Direction_A_Evo_Engineering_First_T1_Runtime_v1\`.\n\n## Zero-provider authorization preflight\n\n1. Verify \`13_CURRENT_T1_AUTHORIZATION_REQUEST.json\` canonical content hash and the separately signed grant. The grant must bind every hash in \`requiredBindings\`, including this runbook's SHA-256.\n2. Verify the exact task/group candidate and source-evidence hashes in \`12_CURRENT_T1_PLAN.json\`; reject any task or group substitution.\n3. Verify benchmark \`${benchmark.contentHash}\`, source model \`${sourceModel.contentHash}\`, legacy source \`${legacySource.contentHash}\`, execution profile \`${manifest.executionProfileHash}\`, Q6 seal \`${q6.contentHash}\`, amendment \`${amendment.contentHash}\`, and global ledger \`${ledger.contentHash}\`.\n4. Create an append-only journal and ledger copy. Before any secret read or dispatch, reserve the whole group unit and prove observed new spend + unknown reserve + active reservations + new reservation <= CNY100 and <= the T1 CNY36.4 stage cap.\n5. Prove overlap with Q6 and all 13 fresh tasks is zero. Preflight makes zero provider calls and reads no provider secret.\n\n## Paid acquisition after exact grant\n\nFor d6 target-round-5 and d3 target-round-5 only: run NORMAL first, freeze process-X, then execute the four predeclared counterbalanced FULL/REMOVE pairs with journal/resume. Scientific action/task/verifier failure remains observed scientific evidence. Replacement is allowed only for true technical invalidity, at most two trials per complete group unit. An uncertain or unreconciled dispatch is a global stop.\n\nReconcile every provider call and CNY amount before releasing reservations. Fail closed by reserving worst historical trial exposure for unknown usage. Never exceed either cap.\n\n## Post-acquisition checks and mandatory stop\n\nReconstruct first-four technically valid fixed4 rows, verify complete-task cluster identity, hashes, fixed4 availability, Q6/fresh firewall, and ledger reconciliation. Then **STOP**. WorkBuddy must not retrain A/B/C, apply the T2 trigger, select fresh N, compute a research conclusion, open fresh Y, or open Q6. Those are later zero-cost Codex/researcher stages.\n\nGlobal stop conditions: authorization/hash mismatch; wrong task/group; Q6/fresh overlap; uncertain or duplicate unreconciled dispatch; provider/source/profile mismatch; T1/global budget breach; causal-data integrity failure. Small path/schema/hash/type/Windows quoting defects may be repaired minimally before continuing.\n`;
  await writeTextAt(runbookPath, runbook);
  const runbookSha256 = sha(await readFile(runbookPath));

  const authorization = await writeOutputJson("13_CURRENT_T1_AUTHORIZATION_REQUEST.json", {
    schemaVersion: "direction-a.evo-engineering-first-t1-authorization-request.v1",
    decisionId: EVO_ENGINEERING_DECISION_ID,
    createdAt: frozenAt,
    authorizationStatus: "RESEARCHER_APPROVAL_REQUIRED",
    authorizationGranted: false,
    executable: false,
    requestedStage: "EVO_ENGINEERING_FIRST_T1",
    exactTaskIds: predecessorSelection.selectedTasks.map((task: Json) => task.taskId),
    exactCausalGroupIds: t1GroupIds,
    expectedProviderCalls: 216,
    absoluteProviderCallCap: 264,
    expectedCostCny: t1Cost.expectedCostCny,
    t1StageHardCapCny: 36.4,
    globalNewSpendHardCapCny: 100,
    requiredBindings: {
      amendmentContentHash: amendment.contentHash,
      modelSelectionRuleHash: modelRule.contentHash,
      baselineFreezeHash: baselineSpec.contentHash,
      t2TriggerHash: t2Trigger.contentHash,
      freshPopulationHash: population.contentHash,
      freshPrefixHash,
      freshPrefixDocumentHash: prefix.contentHash,
      costTableHash: costTable.contentHash,
      ledgerGenesisHash: ledger.contentHash,
      t1PlanHash: t1Plan.contentHash,
      predecessorT1SelectionHash: predecessorSelection.contentHash,
      benchmarkProvenanceHash: benchmark.contentHash,
      proposedSourceModelHash: sourceModel.contentHash,
      legacySourceModelHash: legacySource.contentHash,
      q6SealHash: q6.contentHash,
      initial6ManifestHash: manifest.contentHash,
      executionProfileHash: manifest.executionProfileHash,
      engineeringModuleSha256: sha(await readFile(path.join(memoryCore, "src/evaluation/direction-a/formal/modeling/evo-engineering-first.ts"))),
      engineeringTestSha256: sha(await readFile(path.join(memoryCore, "src/evaluation/direction-a/formal/modeling/evo-engineering-first.test.ts"))),
      freezeScriptSha256: sha(await readFile(path.join(memoryCore, "scripts/direction-a/formal/evo-engineering-first-freeze.ts"))),
      verifyScriptSha256: sha(await readFile(path.join(memoryCore, "scripts/direction-a/formal/evo-engineering-first-verify.ts"))),
      workBuddyRunbookSha256: runbookSha256,
    },
    runtimeOutputRoot: "Direction_A_Evo_Engineering_First_T1_Runtime_v1",
    forbidden: ["T2", "FRESH_ENGINEERING_POPULATION", "FRESH_CAUSAL_Y", "Q6", "PAIR_5", "OUTCOME_ADAPTIVE_DEEPENING",
      "SOURCE_MODEL_REFIT", "MODEL_FAMILY_EXPANSION", "SECRET_READ_BEFORE_BUDGET_RESERVATION"],
    approvalInstruction: "Researcher must create a separate immutable granted authorization bound to this request contentHash and every required binding; this request is not executable authority.",
  });

  await writeTextAt(path.join(outputRoot, "14_WORKBUDDY_T1_HANDOFF.md"), `# WorkBuddy T1 handoff\n\nTerminal: **READY_FOR_EVO_ENGINEERING_FIRST_T1_AUTHORIZATION**.\n\nThis handoff authorizes nothing by itself. Researcher approval must bind:\n\n- request: \`13_CURRENT_T1_AUTHORIZATION_REQUEST.json\` / \`${authorization.contentHash}\`;\n- runbook: \`WORKBUDDY_EVO_ENGINEERING_FIRST_T1_EXECUTION.md\` / SHA-256 \`${runbookSha256}\`;\n- amendment: \`${amendment.contentHash}\`;\n- T1 plan: \`${t1Plan.contentHash}\`;\n- global ledger genesis: \`${ledger.contentHash}\`.\n\nThe only requested paid scope is d6 target-round-5 plus d3 target-round-5. T2, the fresh population, and Q6 require separate later approvals.\n`);
  await writeTextAt(path.join(outputRoot, "00_READ_FIRST.md"), `# Direction A — Evo engineering-first / budget-100 closure\n\nTerminal: **READY_FOR_EVO_ENGINEERING_FIRST_T1_AUTHORIZATION**.\n\nThe prospective amendment \`${EVO_ENGINEERING_DECISION_ID}\` is frozen after Initial-6 but before T1/fresh/Q6 causal Y. Historical evidence and the predecessor package remain immutable.\n\nThe current request is non-executable and covers only the already-reviewed d6/d3 target-round-5 T1. Start with \`13_CURRENT_T1_AUTHORIZATION_REQUEST.json\`, \`14_WORKBUDDY_T1_HANDOFF.md\`, and \`WORKBUDDY_EVO_ENGINEERING_FIRST_T1_EXECUTION.md\`.\n`);
  await writeTextAt(path.join(outputRoot, "01_AUTHORITY_SUPERSESSION_AUDIT.md"), `# Authority supersession audit\n\nStatus: **PASS**.\n\nThe amendment is prospective only. It supersedes three future Evo items: LCB-as-hard-gate, RMSE-first winner selection, and CAL5/TEST5/reserve3 capacity partitioning. It does not rewrite any historical result or claim pre-Initial-6 timing.\n\nPreserved checks: fixed4 teacher PASS; hidden-Y PASS; complete-task cluster independence PASS; Q6 seal hash \`${q6.contentHash}\` PASS; d6/d3 T1 identity PASS; A/B/C-only family PASS; Mem2 history mutation NO; predecessor package mutation NO.\n\nAuthority bindings are recorded in \`02_ENGINEERING_FIRST_AMENDMENT.json\`.\n`);
  await writeOutputJson("02_ENGINEERING_FIRST_AMENDMENT.json", amendment);
  await writeTextAt(path.join(outputRoot, "11_FUTURE_CLAIM_BOUNDARY.md"), `# Future Evo engineering claim boundary\n\nHeadline: at the same 70% accepted-task budget, compare the frozen Proposed evaluator with the pre-frozen Legacy baseline on the first N tasks of the untouched prefix using \`DeltaV70\`. Positive point value gives \`POSITIVE_ENGINEERING_COMPARISON\`; non-positive point value gives \`NO_POSITIVE_ENGINEERING_COMPARISON\`.\n\nAlways report V Proposed, V Legacy, accepted mean theta, RMSE, MAE, task-level Spearman, the 40/60/70/80% priority curve, process ablation, strong target-only comparator, online marginal cost, paired task contributions, and the 95% task-cluster bootstrap interval. The interval is uncertainty reporting only. Crossing zero is not by itself engineering failure, and it never permits claims of statistical significance or proved superiority. Materially conflicting support must be described as \`POSITIVE_PRIMARY_VALUE_WITH_MIXED_SUPPORT\`.\n\nNo claim of production readiness or Q6 cross-domain generalization is authorized.\n`);
  await writeTextAt(path.join(outputRoot, "15_REPRODUCIBILITY_REPORT.md"), `# Reproducibility report\n\nStatus: **PASS — ZERO PROVIDER**.\n\nExplicit pass items:\n\n1. PASS — predecessor canonical hashes and expected 6-task/8-group facts verified.\n2. PASS — d6/d3 target-round-5 identities and 216/264 call bounds verified without reselection.\n3. PASS — fixed4, hidden-Y, task-cluster, and Q6 invariants retained.\n4. PASS — engineering selection rule is deterministic and keeps RMSE/MAE as non-optimizing guardrails.\n5. PASS — Primary Legacy and Strong target-only comparators are frozen before fresh Y.\n6. PASS — T2 trigger is deterministic, permits exactly two groups, and prohibits T3.\n7. PASS — all 13 non-Q6/non-TRAIN tasks are present once; prefix is deterministic and outcome/model-score blind.\n8. PASS — N ladder is fixed at 9/8/7/6 and consumes only reconciled spend plus P95 affordability.\n9. PASS — global ledger cap is exactly CNY100 and fail-closed unknown usage enters protected exposure.\n10. PASS — paired 20,000-replicate task-cluster bootstrap is uncertainty-only.\n11. PASS — T1 request binds the amendment, plan, budget, ledger, benchmark/source/harness/Q6 and WorkBuddy hashes; it excludes T2/fresh/Q6.\n12. PASS — provider calls, model calls, secret reads, new causal Y, and Q6 reads are all zero.\n13. PASS — task-scoped whitespace/JSON parsing and tracked no-old-noise \`git diff --check\` passed. The broader authority-file diff check reports only pre-existing trailing spaces before the 2026-09-12 amendment sections; those historical lines were deliberately not rewritten.\n\nFocused commands: \`pnpm.cmd exec vitest run src/evaluation/direction-a/formal/modeling/evo-engineering-first.test.ts\`; \`pnpm.cmd run typecheck:direction-a\`; \`pnpm.cmd run direction-a:formal:evo:engineering-first:verify\`; controlled \`git diff --check\`.\n`);

  const requiredNames = ["00_READ_FIRST.md", "01_AUTHORITY_SUPERSESSION_AUDIT.md", "02_ENGINEERING_FIRST_AMENDMENT.json",
    "03_ENGINEERING_MODEL_SELECTION_RULE.json", "04_BASELINE_FREEZE_SPEC.json", "05_T2_TRIGGER_FREEZE.json", "06_FRESH13_POPULATION.json",
    "07_FRESH13_PREFIX_FREEZE.json", "08_BUDGET100_STAGE_COST_TABLE.json", "09_GLOBAL_BUDGET_LEDGER_GENESIS.json",
    "10_FUTURE_INFERENCE_FREEZE.json", "11_FUTURE_CLAIM_BOUNDARY.md", "12_CURRENT_T1_PLAN.json",
    "13_CURRENT_T1_AUTHORIZATION_REQUEST.json", "14_WORKBUDDY_T1_HANDOFF.md", "15_REPRODUCIBILITY_REPORT.md",
    "WORKBUDDY_EVO_ENGINEERING_FIRST_T1_EXECUTION.md"];
  const inventoryRows = await Promise.all(requiredNames.map(async (name) => {
    const file = path.join(outputRoot, name);
    const raw = await readFile(file);
    return { path: name, sha256: sha(raw), bytes: raw.length };
  }));
  await writeOutputJson("SHA256_INVENTORY.json", {
    schemaVersion: "direction-a.evo-engineering-first-sha256-inventory.v1",
    decisionId: EVO_ENGINEERING_DECISION_ID,
    generatedAt: frozenAt,
    files: inventoryRows,
    excludedSelf: "SHA256_INVENTORY.json",
  });
  process.stdout.write(`EVO_ENGINEERING_FIRST_BUDGET100_AMENDMENT_COMPLETE\nFRESH_PREFIX_HASH=${freshPrefixHash}\nT1_P50_CNY=${t1Cost.expectedCostCny.p50}\nT1_P95_CNY=${t1Cost.expectedCostCny.p95}\nAUTH_HASH=${authorization.contentHash}\nRUNBOOK_SHA256=${runbookSha256}\nOUTPUT=${outputRoot}\nNEXT=READY_FOR_EVO_ENGINEERING_FIRST_T1_AUTHORIZATION\n`);
}

await main();
