import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { hashCanonical, immutableCopy } from "../core/canonical.js";
import { assertPairSchedule, type PairSchedule } from "../acquisition/integrity.js";
import type { Initial6PreparedGroupManifest } from "../pilot/initial6-manifest.js";
import { FRESH_ACTIVE_PREFIX_N, FRESH_FROZEN_N9_PREFIX_LENGTH, FRESH_EXPECTED_CALLS, FRESH_MAX_CALLS,
  FRESH_P95_RESERVATION_CNY, FRESH_HISTORICAL_FRESH_SPEND_CNY, FRESH_INCREMENTAL_BUDGET_CAP_CNY,
  FRESH_ABSOLUTE_ACCOUNTING_CEILING_CNY, FRESH_PROTECTED_TOTAL_CNY, FRESH_PEAK_PRICING } from "./fresh-paid-authority.js";

export const FRESH_DECISION_ID = "EVO_FRESH_PEAK100_PREFIX5_2026_09_14" as const;
export const FRESH_RUNTIME_ROOT = "C:\\Users\\L2503\\Desktop\\TencentDB-Agent-Memory\\Direction_A_Evo_Fresh_Engineering_Holdout_N9_Runtime_v1" as const;
export const FRESH_PREFIX_HASH = "6e8b74252ee788620eda9d96a1682da89a5aeafc01d8b90320366889af40c555" as const;

/**
 * Mechanical peak-budget prefix freeze (researcher decision 2026-09-14).
 *
 * The frozen N9 task order below is the authority for identity and ordering and is never
 * re-sampled, re-ordered, or cheap-X/outcome selected. The only change is the number of
 * complete tasks the newly authorized peak CNY100 budget can mechanically protect:
 * 5 complete tasks at the peak-equivalent per-task reservation, with task 6 structurally
 * forbidden even if realised spend after task 5 stays far below CNY100.
 */
export const FRESH_N = FRESH_ACTIVE_PREFIX_N;

export interface FreshTaskIdentity {
  prefixIndex: number;
  taskId: string;
  statisticalClusterId: string;
  officialDomainId: string;
  canonicalCausalGroupId: string;
  targetRound: number;
  taskCandidateHash: string;
  sourceTaskDirectoryHash: string;
  groupCandidateHash: string;
  sourceEvidenceHash: string;
}

/** Frozen N9 task order. Byte-frozen identity/order authority; never re-sampled or re-ordered. */
const FROZEN_N9_PREFIX_TASKS: readonly FreshTaskIdentity[] = [
  { prefixIndex: 1, taskId: "theme_d11_w2_scientific_numerical_brownfield_modification", statisticalClusterId: "theme_d11_w2_scientific_numerical_brownfield_modification", officialDomainId: "d11", canonicalCausalGroupId: "theme_d11_w2_scientific_numerical_brownfield_modification:target-round-4", targetRound: 4, taskCandidateHash: "298f62b91593637896b22455d22e3467e19fe1b5525017fecc9c67789af2ed88", sourceTaskDirectoryHash: "1cd018f1d339423c88e7cf389a2e45b405c14c03bbd2ddf1c8a84ec40c406665", groupCandidateHash: "8ae75a1e7ac9f2cb4fbda0d0196b0942e065029fc1ff307da886a96f8cc88e58", sourceEvidenceHash: "884177fa0ef5318b242a43670d6ee825926d9bf568f693699fc4269a7888c332" },
  { prefixIndex: 2, taskId: "theme_d10_w4_ml_ai_mlops_migration_upgrade", statisticalClusterId: "theme_d10_w4_ml_ai_mlops_migration_upgrade", officialDomainId: "d10", canonicalCausalGroupId: "theme_d10_w4_ml_ai_mlops_migration_upgrade:target-round-6", targetRound: 6, taskCandidateHash: "ed35e6344ec1f2a5dd684501ae8d1c588c16e25cc4bfd45b0f08a5800d3892b2", sourceTaskDirectoryHash: "5ab0d73711b583de5462e585f1b2a08fe6077215def9095ccdef09876f678b6a", groupCandidateHash: "c818d379e17fd17a636ea4de061203745dc9e52d9df34bd21d67190172b62ce1", sourceEvidenceHash: "4c93ab3e28af478553178dec8d483664e7e1d58c677d8abf7e0b08eeb8b8f1bc" },
  { prefixIndex: 3, taskId: "theme_d12_w1_automation_productivity_greenfield_implementation", statisticalClusterId: "theme_d12_w1_automation_productivity_greenfield_implementation", officialDomainId: "d12", canonicalCausalGroupId: "theme_d12_w1_automation_productivity_greenfield_implementation:target-round-7", targetRound: 7, taskCandidateHash: "edfee50ef4f1797aba624db85d59f183f810657e288e87ee16af4942723bf9ab", sourceTaskDirectoryHash: "68a4239182599b68cf5b467757f9cb6a7e58aa29596f66954b004760de2bdf3a", groupCandidateHash: "632c3fde73f38099fcad0a04df93d69acb52ad11d22fecf5712354d6cfcc1f95", sourceEvidenceHash: "9944142f94e7ce8d49f6a390f1f1f974d166b998d3502e7cb8d6513b4f903a7a" },
  { prefixIndex: 4, taskId: "theme_d5_w5_data_engineering_integration_e2e_wiring", statisticalClusterId: "theme_d5_w5_data_engineering_integration_e2e_wiring", officialDomainId: "d5", canonicalCausalGroupId: "theme_d5_w5_data_engineering_integration_e2e_wiring:target-round-6", targetRound: 6, taskCandidateHash: "a690bab698637aacd80ba2354bccc4989046abcbdb4f67b63af4f6389af7aaec", sourceTaskDirectoryHash: "6ae3125c1a97785f837cf6897856b68211f805b328da6b86339bd764ff614cb4", groupCandidateHash: "f477c92a5941fcde168865c21f74f09ed0fb00d301999e429c8c9154e2625ca0", sourceEvidenceHash: "e69cfab3c7ee077c12fa2b2248cb939f966f48616cee45c34bd67f7a7853baa5" },
  { prefixIndex: 5, taskId: "theme_d11_w2_scientific_numerical_brownfield_modification__not_1234", statisticalClusterId: "theme_d11_w2_scientific_numerical_brownfield_modification__not_1234", officialDomainId: "d11", canonicalCausalGroupId: "theme_d11_w2_scientific_numerical_brownfield_modification__not_1234:target-round-4", targetRound: 4, taskCandidateHash: "40d8413b269731b3d2fc56e9ddb27d09654278eea3ac41ebc00cd61ee873ce87", sourceTaskDirectoryHash: "a2af4e57ad5bf03d57b8448852ca863e5ef3afbddc9549bc5dad60ff1b29d46a", groupCandidateHash: "7dd9d74f2f8af80ea9e2d4d329e22f48cb8e130c2a659ed20a8fbc6847eacb2d", sourceEvidenceHash: "8d601c49682d2e07fd233cf77fffa5631b08d1ab3a338518606375a4dcd90671" },
  { prefixIndex: 6, taskId: "theme_d10_w12_ml_ai_mlops_explanation_reporting", statisticalClusterId: "theme_d10_w12_ml_ai_mlops_explanation_reporting", officialDomainId: "d10", canonicalCausalGroupId: "theme_d10_w12_ml_ai_mlops_explanation_reporting:target-round-3", targetRound: 3, taskCandidateHash: "33524d3cb6ab0d2fac37cb0b720d4d6dea658934305ca7a3458b7428bd6ad3ad", sourceTaskDirectoryHash: "334489756ef976bd5bebed06145211aa7344f4b64d9d86d8b93fcf1c4c42af77", groupCandidateHash: "e9aa0952b960372c629f893fa9ad386ae939c2483c076740efdb09ebd7290234", sourceEvidenceHash: "5f861934d266fdf38ad5a7788fa3c261ce8ad8c198af80541b70d7ecf558564d" },
  { prefixIndex: 7, taskId: "theme_d5_w1_data_engineering_greenfield_implementation", statisticalClusterId: "theme_d5_w1_data_engineering_greenfield_implementation", officialDomainId: "d5", canonicalCausalGroupId: "theme_d5_w1_data_engineering_greenfield_implementation:target-round-6", targetRound: 6, taskCandidateHash: "ba0c0de960a4bc264e9f71f5be576a33a5d5292e37710da8b0c3ed6df5566178", sourceTaskDirectoryHash: "364e6a6022a5df4db7ffc532f0600338e94aeb9b01cdab5727f276e1c3e88fb7", groupCandidateHash: "424fc9ec543b7c89c042a9673f0e33318acb4fa2723ec37ffa48dedff7079450", sourceEvidenceHash: "f8349932c517bd7b99688a81554a5df7b85d2cb8ddfba48c0d1c80de6427aeff" },
  { prefixIndex: 8, taskId: "theme_d10_w9_ml_ai_mlops_reproducibility_verification", statisticalClusterId: "theme_d10_w9_ml_ai_mlops_reproducibility_verification", officialDomainId: "d10", canonicalCausalGroupId: "theme_d10_w9_ml_ai_mlops_reproducibility_verification:target-round-5", targetRound: 5, taskCandidateHash: "633c83742321de6a23cd7f01bd99f26946b4e8ffb09542b00072272099a0a039", sourceTaskDirectoryHash: "5067ae3805634a9e26e92fd812a00dd0b16d383f8ba96f87118a6e0aafee204f", groupCandidateHash: "cd33a72260feb647e195a03e2c76e53394aae78efecb77ef80b6528e2d478bfb", sourceEvidenceHash: "107ee8b32522bb5736eef87a062fe0873d0e4522e7ae44fea9f9b97aca339062" },
  { prefixIndex: 9, taskId: "theme_d10_w2_ml_ai_mlops_brownfield_modification", statisticalClusterId: "theme_d10_w2_ml_ai_mlops_brownfield_modification", officialDomainId: "d10", canonicalCausalGroupId: "theme_d10_w2_ml_ai_mlops_brownfield_modification:target-round-3", targetRound: 3, taskCandidateHash: "c67d322c5dbed69c95a39ed0f39172ec88c4dc7f1e5c99e61430e93fe3c7b49e", sourceTaskDirectoryHash: "6df79e9a063b1731c7b3d634889e4c6d5958b84f778534cc278d8797ed667e85", groupCandidateHash: "fe4c6ad64a67776852314848bda4aa87dde32b63bfdb1aa5e27df6d79e19f2b0", sourceEvidenceHash: "00964aad5bd7dbfa34f4e8bb1b9a8746eedebd7d19780e7e64f5173f3c191d2e" },
] as const;

if (FROZEN_N9_PREFIX_TASKS.length !== FRESH_FROZEN_N9_PREFIX_LENGTH
  || FROZEN_N9_PREFIX_TASKS.some((task, index) => task.prefixIndex !== index + 1)) {
  throw new Error("FRESH_FROZEN_N9_PREFIX_IDENTITY_TABLE_INVALID");
}

/** The only scientifically active tasks: the exact ordered prefix 1..5 of the frozen N9 order. */
export const FRESH_ACTIVE_TASKS: readonly FreshTaskIdentity[] = Object.freeze(
  FROZEN_N9_PREFIX_TASKS.slice(0, FRESH_ACTIVE_PREFIX_N).map((task) => Object.freeze({ ...task })));
/** Tasks 6..9 of the frozen N9 order. Structurally forbidden in this budget-prefix freeze. */
export const FRESH_FORBIDDEN_TAIL_TASKS: readonly FreshTaskIdentity[] = Object.freeze(
  FROZEN_N9_PREFIX_TASKS.slice(FRESH_ACTIVE_PREFIX_N).map((task) => Object.freeze({ ...task })));
export const FRESH_FORBIDDEN_TAIL_TASK_IDS: readonly string[] = Object.freeze(FRESH_FORBIDDEN_TAIL_TASKS.map((task) => task.taskId));
export const FRESH_FROZEN_N9_TASK_IDS: readonly string[] = Object.freeze(FROZEN_N9_PREFIX_TASKS.map((task) => task.taskId));
export const FRESH_TASK_IDS: readonly string[] = Object.freeze(FRESH_ACTIVE_TASKS.map((row) => row.taskId));
export const FRESH_GROUP_IDS: readonly string[] = Object.freeze(FRESH_ACTIVE_TASKS.map((row) => row.canonicalCausalGroupId));
/** Canonical hash of the mechanically frozen active prefix; binds the exact sample manifest. */
export const FRESH_ACTIVE_PREFIX_TASK_HASH = hashCanonical(FRESH_ACTIVE_TASKS);

export interface FreshSourceInventoryEntry extends FreshTaskIdentity {
  sourceMemoryRound: number;
  sourceTaskRelativePath: string;
  sourceMemoryInstructionRelativePath: string;
  targetInstructionRelativePath: string;
  targetTestsRelativePath: string;
}

export interface FreshExactManifest {
  schemaVersion: "direction-a.evo-fresh-n9-exact-manifest.v1";
  decisionId: typeof FRESH_DECISION_ID;
  stage: "EVO_FRESH_ENGINEERING_HOLDOUT";
  status: "FROZEN_PENDING_RESEARCHER_REAUTHORIZATION";
  prefixHash: typeof FRESH_PREFIX_HASH;
  activePrefixN: number;
  frozenN9PrefixLength: number;
  activePrefixTaskHash: string;
  forbiddenTailTaskIds: string[];
  budgetPrefixFreeze: "OUTCOME_BLIND_MAXIMUM_COMPLETE_PREFIX";
  exactTaskIds: string[];
  exactCausalGroupIds: string[];
  tasks: FreshTaskIdentity[];
  sourceInventory: FreshSourceInventoryEntry[];
  overlapProof: { trainTaskIds: []; q6TaskIds: []; t2TaskIds: [] };
  protocol: { normalPerTask: 1; fixedPairCount: 4; pair5Forbidden: true; technicalReplacementLimitPerTask: 2; scientificFailureIsValidObservation: true; task6Forbidden: true };
  budget: FreshExactManifestBudget;
  contentHash: string;
}

export interface FreshExactManifestBudget {
  activePrefixN: number;
  expectedProviderCalls: 540;
  maximumProviderCalls: 660;
  p95ReservationCny: 19.868557;
  incrementalBudgetCapCny: 100;
  priorReconciledSpendCny: 10.022517;
  priorSpendTreatment: "HISTORICAL_FRESH_SPEND_CHARGED_TO_FRESH_CNY100";
  protectedTotalCny: 29.891074;
  globalHardCapCny: 100;
  peakPricing: true;
  budgetRole: "TELEMETRY_ONLY_NEVER_BLOCKS_EXECUTION";
  budgetNeverFailsClosed: true;
}

export function freshExactManifestBudget(): FreshExactManifestBudget {
  if (!FRESH_PEAK_PRICING) throw new Error("FRESH_EXACT_MANIFEST_PEAK_PRICING_REQUIRED");
  return { activePrefixN: FRESH_ACTIVE_PREFIX_N, expectedProviderCalls: 540, maximumProviderCalls: 660,
    p95ReservationCny: 19.868557, incrementalBudgetCapCny: 100,
    priorReconciledSpendCny: 10.022517, priorSpendTreatment: "HISTORICAL_FRESH_SPEND_CHARGED_TO_FRESH_CNY100", protectedTotalCny: 29.891074,
    globalHardCapCny: 100, peakPricing: true, budgetRole: "TELEMETRY_ONLY_NEVER_BLOCKS_EXECUTION", budgetNeverFailsClosed: true };
}

export function assertFreshExactManifestBudget(budget: FreshExactManifestBudget): void {
  if (budget.expectedProviderCalls !== FRESH_EXPECTED_CALLS || budget.maximumProviderCalls !== FRESH_MAX_CALLS
    || budget.p95ReservationCny !== FRESH_P95_RESERVATION_CNY || budget.incrementalBudgetCapCny !== FRESH_INCREMENTAL_BUDGET_CAP_CNY
    || budget.priorReconciledSpendCny !== FRESH_HISTORICAL_FRESH_SPEND_CNY || budget.priorSpendTreatment !== "HISTORICAL_FRESH_SPEND_CHARGED_TO_FRESH_CNY100"
    || budget.protectedTotalCny !== FRESH_PROTECTED_TOTAL_CNY || budget.globalHardCapCny !== FRESH_ABSOLUTE_ACCOUNTING_CEILING_CNY
    || budget.peakPricing !== FRESH_PEAK_PRICING || budget.activePrefixN !== FRESH_ACTIVE_PREFIX_N
    || budget.budgetRole !== "TELEMETRY_ONLY_NEVER_BLOCKS_EXECUTION" || budget.budgetNeverFailsClosed !== true
    || hashCanonical(budget) !== hashCanonical(freshExactManifestBudget())) {
    throw new Error("FRESH_BUDGET_SCOPE_MISMATCH");
  }
}

export type FreshPreparedGroup = Omit<Initial6PreparedGroupManifest, "selectionRole" | "deepReference" | "validPairMaximum" | "validPairMinimum"> & {
  selectionRole: "FRESH_N9_FIXED";
  deepReference: false;
  validPairMaximum: 4;
  validPairMinimum: 4;
  sourceMemoryRound: number;
  prefixIndex: number;
  taskCandidateHash: string;
  sourceTaskDirectoryHash: string;
  groupCandidateHash: string;
  sourceEvidenceHash: string;
  targetInstructionHash: string;
  targetTestsDirectoryHash: string;
  nativeTargetTestsDirectoryHash?: string;
  preparedTargetTestsDirectoryHash?: string;
  caseAccounting?: null | {
    version: "direction-a.evo-fresh-failfast-case-accounting.v1";
    nativeVerifierSha256: string;
    normalizedVerifierSha256: string;
    registeredCaseCount: number;
  };
  externalPrefixArtifacts?: Array<{ targetPath: string; relativePath: string; sha256: string; requiredExecutable: true }>;
};

export interface FreshPreparedExecutionManifest {
  schemaVersion: "direction-a.evo-fresh-n9-prepared-manifest.v1" | "direction-a.evo-fresh-n9-prepared-manifest.v2" | "direction-a.evo-fresh-n9-prepared-manifest.v3";
  decisionId: typeof FRESH_DECISION_ID;
  stage: "EVO_FRESH_ENGINEERING_HOLDOUT";
  runtimeRoot: typeof FRESH_RUNTIME_ROOT;
  exactManifestHash: string;
  executionProfileHash: string;
  denominatorQualificationHash?: string;
  preparationProtocolHash?: string;
  prefixEnvironmentManifestHash?: string;
  groups: FreshPreparedGroup[];
  preparationSemantics: {
    sourceMemoryRound: "TARGET_ROUND_MINUS_ONE";
    normalAndFullTreatment: "SAME_FROZEN_AUTO_INJECTION";
    removeTreatment: "NO_MEMORY_CONTEXT";
    verifier: "EVOCODEBENCH_NATIVE_CASE_SUMMARY" | "EVOCODEBENCH_VERSIONED_COMPLETE_CASE_ACCOUNTING";
    utility: "SUCCESS_COUNT_DIVIDED_BY_FROZEN_TOTAL_CASES";
    technicalReplacementLimitPerTask: 2;
    paidProviderCallsDuringPreparation: 0;
  };
  preparedByDriverSha256: string;
  contentHash: string;
}

function sameOrdered(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

export function expectedFreshTasks(): FreshTaskIdentity[] {
  return structuredClone(FRESH_ACTIVE_TASKS) as FreshTaskIdentity[];
}

/**
 * Structural ban on tasks 6..9 of the frozen N9 order. Task 6 must stay forbidden even when
 * realised spend after task 5 lands far below the CNY100 cap, otherwise the sample size would
 * become post-execution adaptive.
 */
export function assertFreshNoForbiddenTailTask(taskIds: readonly string[]): void {
  const forbidden = taskIds.filter((taskId) => FRESH_FORBIDDEN_TAIL_TASK_IDS.includes(taskId));
  if (forbidden.length) throw new Error(`FRESH_TASK6_PLUS_STRUCTURALLY_FORBIDDEN:${forbidden.join(",")}`);
}

/** The active sample must be a byte-exact ordered prefix of the frozen N9 order. */
export function assertFreshActivePrefixOfFrozenN9(tasks: readonly FreshTaskIdentity[]): void {
  if (tasks.length !== FRESH_ACTIVE_PREFIX_N
    || !sameOrdered(tasks.map((row) => row.taskId), FRESH_TASK_IDS)
    || !sameOrdered(tasks.map((row) => row.canonicalCausalGroupId), FRESH_GROUP_IDS)
    || hashCanonical(tasks) !== FRESH_ACTIVE_PREFIX_TASK_HASH) {
    throw new Error("FRESH_ACTIVE_PREFIX_IS_NOT_FROZEN_N9_PREFIX_1_5");
  }
  assertFreshNoForbiddenTailTask(tasks.map((row) => row.taskId));
}

export function assertFreshTaskSet(tasks: readonly FreshTaskIdentity[]): void {
  if (tasks.length !== FRESH_N || hashCanonical(tasks) !== FRESH_ACTIVE_PREFIX_TASK_HASH) {
    throw new Error("FRESH_EXACT_ACTIVE_PREFIX_TASK_SET_MISMATCH");
  }
  assertFreshActivePrefixOfFrozenN9(tasks);
}

export function createFreshExactManifest(): FreshExactManifest {
  const tasks = expectedFreshTasks();
  const sourceInventory = tasks.map((task) => ({ ...task, sourceMemoryRound: task.targetRound - 1,
    sourceTaskRelativePath: `.research/direction-a/v6.3/dependencies/evocodebench_wotraj/${task.taskId}`,
    sourceMemoryInstructionRelativePath: `.research/direction-a/v6.3/dependencies/evocodebench_wotraj/${task.taskId}/steps/round-${task.targetRound - 1}/instruction.md`,
    targetInstructionRelativePath: `.research/direction-a/v6.3/dependencies/evocodebench_wotraj/${task.taskId}/steps/round-${task.targetRound}/instruction.md`,
    targetTestsRelativePath: `.research/direction-a/v6.3/dependencies/evocodebench_wotraj/${task.taskId}/steps/round-${task.targetRound}/tests`,
  }));
  const body = { schemaVersion: "direction-a.evo-fresh-n9-exact-manifest.v1" as const, decisionId: FRESH_DECISION_ID,
    stage: "EVO_FRESH_ENGINEERING_HOLDOUT" as const, status: "FROZEN_PENDING_RESEARCHER_REAUTHORIZATION" as const,
    prefixHash: FRESH_PREFIX_HASH, activePrefixN: FRESH_ACTIVE_PREFIX_N, frozenN9PrefixLength: FRESH_FROZEN_N9_PREFIX_LENGTH,
    activePrefixTaskHash: FRESH_ACTIVE_PREFIX_TASK_HASH, forbiddenTailTaskIds: [...FRESH_FORBIDDEN_TAIL_TASK_IDS],
    budgetPrefixFreeze: "OUTCOME_BLIND_MAXIMUM_COMPLETE_PREFIX" as const,
    exactTaskIds: tasks.map((row) => row.taskId), exactCausalGroupIds: tasks.map((row) => row.canonicalCausalGroupId),
    tasks, sourceInventory, overlapProof: { trainTaskIds: [] as [], q6TaskIds: [] as [], t2TaskIds: [] as [] },
    protocol: { normalPerTask: 1 as const, fixedPairCount: 4 as const, pair5Forbidden: true as const,
      technicalReplacementLimitPerTask: 2 as const, scientificFailureIsValidObservation: true as const, task6Forbidden: true as const },
    budget: freshExactManifestBudget() };
  return immutableCopy({ ...body, contentHash: hashCanonical(body) }) as FreshExactManifest;
}

export function assertFreshExactManifest(value: FreshExactManifest): void {
  const { contentHash, ...body } = value;
  if (hashCanonical(body) !== contentHash) throw new Error("FRESH_EXACT_MANIFEST_HASH_MISMATCH");
  if (value.schemaVersion !== "direction-a.evo-fresh-n9-exact-manifest.v1" || value.decisionId !== FRESH_DECISION_ID
    || value.stage !== "EVO_FRESH_ENGINEERING_HOLDOUT" || value.status !== "FROZEN_PENDING_RESEARCHER_REAUTHORIZATION"
    || value.prefixHash !== FRESH_PREFIX_HASH || value.activePrefixN !== FRESH_ACTIVE_PREFIX_N
    || value.frozenN9PrefixLength !== FRESH_FROZEN_N9_PREFIX_LENGTH || value.activePrefixTaskHash !== FRESH_ACTIVE_PREFIX_TASK_HASH
    || value.budgetPrefixFreeze !== "OUTCOME_BLIND_MAXIMUM_COMPLETE_PREFIX"
    || hashCanonical(value.forbiddenTailTaskIds) !== hashCanonical(FRESH_FORBIDDEN_TAIL_TASK_IDS)) {
    throw new Error("FRESH_EXACT_MANIFEST_AUTHORITY_MISMATCH");
  }
  assertFreshTaskSet(value.tasks);
  if (!sameOrdered(value.exactTaskIds, FRESH_TASK_IDS) || !sameOrdered(value.exactCausalGroupIds, FRESH_GROUP_IDS)) throw new Error("FRESH_EXACT_MANIFEST_SCOPE_MISMATCH");
  if (value.sourceInventory.length !== FRESH_N || value.sourceInventory.some((row, index) => {
    const { sourceMemoryRound, sourceTaskRelativePath, sourceMemoryInstructionRelativePath, targetInstructionRelativePath,
      targetTestsRelativePath, ...identity } = row;
    return hashCanonical(identity) !== hashCanonical(FRESH_ACTIVE_TASKS[index]) || sourceMemoryRound !== row.targetRound - 1
      || sourceTaskRelativePath !== `.research/direction-a/v6.3/dependencies/evocodebench_wotraj/${row.taskId}`
      || !sourceMemoryInstructionRelativePath.endsWith(`/steps/round-${sourceMemoryRound}/instruction.md`)
      || !targetInstructionRelativePath.endsWith(`/steps/round-${row.targetRound}/instruction.md`)
      || !targetTestsRelativePath.endsWith(`/steps/round-${row.targetRound}/tests`);
  })) throw new Error("FRESH_SOURCE_INVENTORY_MISMATCH");
  if (value.overlapProof.trainTaskIds.length || value.overlapProof.q6TaskIds.length || value.overlapProof.t2TaskIds.length) {
    throw new Error("FRESH_FORBIDDEN_TRAIN_Q6_T2_OVERLAP");
  }
  if (hashCanonical(value.protocol) !== hashCanonical({ normalPerTask: 1, fixedPairCount: 4, pair5Forbidden: true,
    technicalReplacementLimitPerTask: 2, scientificFailureIsValidObservation: true, task6Forbidden: true })) throw new Error("FRESH_PROTOCOL_MISMATCH");
  assertFreshExactManifestBudget(value.budget);
}

export function assertFreshPreparedExecutionManifest(value: FreshPreparedExecutionManifest, exact: FreshExactManifest): void {
  assertFreshExactManifest(exact);
  const { contentHash, ...body } = value;
  if (hashCanonical(body) !== contentHash || value.exactManifestHash !== exact.contentHash) throw new Error("FRESH_PREPARED_MANIFEST_HASH_OR_SCOPE_MISMATCH");
  if (!(["direction-a.evo-fresh-n9-prepared-manifest.v1", "direction-a.evo-fresh-n9-prepared-manifest.v2", "direction-a.evo-fresh-n9-prepared-manifest.v3"] as const).includes(value.schemaVersion)
    || value.decisionId !== FRESH_DECISION_ID
    || value.stage !== "EVO_FRESH_ENGINEERING_HOLDOUT" || value.runtimeRoot !== FRESH_RUNTIME_ROOT
    || !/^[a-f0-9]{64}$/.test(value.executionProfileHash) || !/^[a-f0-9]{64}$/.test(value.preparedByDriverSha256)) {
    throw new Error("FRESH_PREPARED_MANIFEST_AUTHORITY_MISMATCH");
  }
  if (value.groups.length !== FRESH_N || !sameOrdered(value.groups.map((row) => row.taskId), FRESH_TASK_IDS)
    || !sameOrdered(value.groups.map((row) => row.causalGroupId), FRESH_GROUP_IDS)) throw new Error("FRESH_PREPARED_MANIFEST_EXACT_N9_SCOPE_MISMATCH");
  assertFreshNoForbiddenTailTask(value.groups.map((row) => row.taskId));
  for (const [index, group] of value.groups.entries()) {
    const identity = FRESH_ACTIVE_TASKS[index];
    if (group.prefixIndex !== identity.prefixIndex || group.statisticalClusterId !== identity.statisticalClusterId
      || group.officialDomainId !== identity.officialDomainId || group.targetRound !== identity.targetRound
      || group.sourceMemoryRound !== identity.targetRound - 1 || group.taskCandidateHash !== identity.taskCandidateHash
      || group.sourceTaskDirectoryHash !== identity.sourceTaskDirectoryHash || group.groupCandidateHash !== identity.groupCandidateHash
      || group.sourceEvidenceHash !== identity.sourceEvidenceHash) throw new Error("FRESH_PREPARED_MANIFEST_SOURCE_IDENTITY_MISMATCH");
    assertPairSchedule(group.pairSchedule as PairSchedule);
    if (group.selectionRole !== "FRESH_N9_FIXED" || group.deepReference || group.validPairMinimum !== 4 || group.validPairMaximum !== 4
      || group.technicalRetryReserveTrials !== 2 || group.technicalRetryScope !== "PER_CAUSAL_GROUP_COMPLETE_UNIT_INCLUDING_NORMAL_AND_CAUSAL_ARMS"
      || group.normalTreatmentAvailability !== "SAME_FROZEN_AUTO_INJECTION_AS_FULL" || group.normalCountsAsFullReplicate !== false
      || !Number.isInteger(group.frozenTotalCases) || group.frozenTotalCases < 1
      || !sameOrdered(group.pairSchedule.rows.map((row) => row.pairIndex).sort((a, b) => a - b).map(String), ["1", "2", "3", "4"])) {
      throw new Error("FRESH_PREPARED_MANIFEST_FIXED4_OR_TASK_RETRY_SCOPE_MISMATCH");
    }
    const hashes = [group.normalTaskDirectoryHash, group.fullTaskDirectoryHash, group.removeTaskDirectoryHash, group.frozenPrefixHash,
      group.targetGroupHash, group.recallSnapshotHash, group.guideNormalizationHash, group.normalInstructionHash, group.fullInstructionHash,
      group.preparationArtifactHash, group.targetInstructionHash, group.targetTestsDirectoryHash];
    if (hashes.some((entry) => typeof entry !== "string" || entry.length < 24)) throw new Error("FRESH_PREPARED_MANIFEST_BINDING_MISSING");
    if (value.schemaVersion === "direction-a.evo-fresh-n9-prepared-manifest.v2" || value.schemaVersion === "direction-a.evo-fresh-n9-prepared-manifest.v3") {
      if (!/^[a-f0-9]{64}$/.test(group.nativeTargetTestsDirectoryHash ?? "")
        || !/^[a-f0-9]{64}$/.test(group.preparedTargetTestsDirectoryHash ?? "")
        || group.targetTestsDirectoryHash !== group.preparedTargetTestsDirectoryHash) {
        throw new Error("FRESH_PREPARED_MANIFEST_VERSIONED_TEST_BINDING_MISSING");
      }
      if (group.caseAccounting !== null && (!group.caseAccounting
        || group.caseAccounting.version !== "direction-a.evo-fresh-failfast-case-accounting.v1"
        || group.caseAccounting.registeredCaseCount !== group.frozenTotalCases
        || !/^[a-f0-9]{64}$/.test(group.caseAccounting.nativeVerifierSha256)
        || !/^[a-f0-9]{64}$/.test(group.caseAccounting.normalizedVerifierSha256))) {
        throw new Error("FRESH_PREPARED_MANIFEST_CASE_ACCOUNTING_INVALID");
      }
    }
    if (value.schemaVersion === "direction-a.evo-fresh-n9-prepared-manifest.v3" && group.prefixIndex === 3) {
      const artifact = group.externalPrefixArtifacts?.[0];
      if (group.externalPrefixArtifacts?.length !== 1 || artifact?.targetPath !== "/usr/local/bin/flowr"
        || !/^[a-f0-9]{64}$/.test(artifact.sha256) || artifact.relativePath !== "external-prefix-artifacts/usr/local/bin/flowr"
        || artifact.requiredExecutable !== true) throw new Error("FRESH_PREPARED_PREFIX_ARTIFACT_BINDING_MISSING");
    }
  }
  const expectedSemantics = { sourceMemoryRound: "TARGET_ROUND_MINUS_ONE",
    normalAndFullTreatment: "SAME_FROZEN_AUTO_INJECTION", removeTreatment: "NO_MEMORY_CONTEXT",
    verifier: value.schemaVersion === "direction-a.evo-fresh-n9-prepared-manifest.v2" || value.schemaVersion === "direction-a.evo-fresh-n9-prepared-manifest.v3"
      ? "EVOCODEBENCH_VERSIONED_COMPLETE_CASE_ACCOUNTING" : "EVOCODEBENCH_NATIVE_CASE_SUMMARY",
    utility: "SUCCESS_COUNT_DIVIDED_BY_FROZEN_TOTAL_CASES",
    technicalReplacementLimitPerTask: 2, paidProviderCallsDuringPreparation: 0 };
  if (hashCanonical(value.preparationSemantics) !== hashCanonical(expectedSemantics)) throw new Error("FRESH_TREATMENT_RUNTIME_EQUIVALENCE_MISMATCH");
  if ((value.schemaVersion === "direction-a.evo-fresh-n9-prepared-manifest.v2" || value.schemaVersion === "direction-a.evo-fresh-n9-prepared-manifest.v3")
    && (!/^[a-f0-9]{64}$/.test(value.denominatorQualificationHash ?? "")
      || !/^[a-f0-9]{64}$/.test(value.preparationProtocolHash ?? ""))) {
    throw new Error("FRESH_PREPARED_MANIFEST_DENOMINATOR_QUALIFICATION_UNBOUND");
  }
  if (value.schemaVersion === "direction-a.evo-fresh-n9-prepared-manifest.v3"
    && !/^[a-f0-9]{64}$/.test(value.prefixEnvironmentManifestHash ?? "")) {
    throw new Error("FRESH_PREPARED_PREFIX_ENVIRONMENT_MANIFEST_UNBOUND");
  }
}

async function hashFreshDirectoryTree(directory: string): Promise<string> {
  const paths: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(path); else if (entry.isFile()) paths.push(path);
    }
  };
  await visit(directory); const hash = createHash("sha256");
  for (const path of paths) { hash.update(relative(directory, path).replaceAll("\\", "/")); hash.update("\0"); hash.update(await readFile(path)); hash.update("\0"); }
  return hash.digest("hex");
}

export async function assertFreshPreparedRuntimeBytes(repoRoot: string, value: FreshPreparedExecutionManifest,
  exact: FreshExactManifest): Promise<void> {
  assertFreshPreparedExecutionManifest(value, exact);
  for (const group of value.groups) {
    const paths = { normal: resolve(repoRoot, group.normalTaskPath), full: resolve(repoRoot, group.fullTaskPath), remove: resolve(repoRoot, group.removeTaskPath) };
    const [normalDirectoryHash, fullDirectoryHash, removeDirectoryHash, normalInstruction, fullInstruction, removeInstruction,
      normalTestsHash, fullTestsHash, removeTestsHash] = await Promise.all([
      hashFreshDirectoryTree(paths.normal), hashFreshDirectoryTree(paths.full), hashFreshDirectoryTree(paths.remove),
      readFile(resolve(paths.normal, "steps/target-round/instruction.md")), readFile(resolve(paths.full, "steps/target-round/instruction.md")),
      readFile(resolve(paths.remove, "steps/target-round/instruction.md")), hashFreshDirectoryTree(resolve(paths.normal, "steps/target-round/tests")),
      hashFreshDirectoryTree(resolve(paths.full, "steps/target-round/tests")), hashFreshDirectoryTree(resolve(paths.remove, "steps/target-round/tests")),
    ]);
    const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
    if (normalDirectoryHash !== group.normalTaskDirectoryHash || fullDirectoryHash !== group.fullTaskDirectoryHash
      || removeDirectoryHash !== group.removeTaskDirectoryHash || sha(normalInstruction) !== group.normalInstructionHash
      || sha(fullInstruction) !== group.fullInstructionHash || sha(removeInstruction) !== group.targetInstructionHash
      || normalTestsHash !== group.targetTestsDirectoryHash || fullTestsHash !== group.targetTestsDirectoryHash
      || removeTestsHash !== group.targetTestsDirectoryHash
      || (value.schemaVersion === "direction-a.evo-fresh-n9-prepared-manifest.v2"
        && normalTestsHash !== group.preparedTargetTestsDirectoryHash)) throw new Error(`FRESH_PREPARED_RUNTIME_BYTE_DRIFT:${group.taskId}`);
  }
}
