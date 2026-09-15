import { hashCanonical, immutableCopy } from "../core/canonical.js";
import { FROZEN_DESIGN_BINDING } from "../config/frozen-design.js";
import { INITIAL6_BUDGET_AUTHORITY } from "../config/initial6-budget-authority.js";
import { assertPairSchedule, type PairSchedule } from "../acquisition/integrity.js";
import type { Initial6CostForecast } from "../acquisition/budget.js";
import type { RealExecutionProfile } from "../acquisition/execution-profile.js";
import type { Q6CapacityProxyReport, Q6HoldoutSeal } from "../prepilot/q6-holdout-seal.js";
import { assertQ6HistoricalPreYAttestation, type Q6HistoricalPreYAttestation } from "../prepilot/execution-state-attestation.js";
import { assertReconciledCurrentFormalExecutionStateAttestation, type ReconciledCurrentFormalExecutionStateAttestation } from "../prepilot/execution-reconciliation.js";
import { assertInitial6CostForecast } from "../acquisition/budget.js";
import { assertRealExecutionProfile } from "../acquisition/execution-profile.js";
import { assertQ6HoldoutSeal } from "../prepilot/q6-holdout-seal.js";
import { INITIAL6_DEEP_POLICY, INITIAL6_GROUP_POLICY, INITIAL6_PAIR_POLICY, INITIAL6_TASK_POLICY, type Initial6GroupLadderEntry, type Initial6TaskCandidate } from "./initial6-selection.js";
import { CURRENT_FORMAL_ACTIVE_RUNTIME_ROOT } from "../prepilot/execution-state-attestation.js";

export interface Initial6PreparedGroupManifest {
  causalGroupId: string;
  taskId: string;
  statisticalClusterId: string;
  officialDomainId: string;
  targetRound: number;
  selectionRole: "RANDOM_REFERENCE_ANCHOR" | "ACTIVE";
  deepReference: boolean;
  validPairMaximum: 5 | 8;
  validPairMinimum: 3 | 8;
  technicalRetryReserveTrials: number;
  frozenTotalCases: number;
  normalTaskPath: string;
  fullTaskPath: string;
  removeTaskPath: string;
  normalTaskDirectoryHash: string;
  fullTaskDirectoryHash: string;
  removeTaskDirectoryHash: string;
  frozenPrefixHash: string;
  targetGroupHash: string;
  recallSnapshotHash: string;
  guideNormalizationHash: string;
  normalObservationRole: "CAUSAL_SUPERVISED_SOURCE_X";
  normalTreatmentAvailability: "SAME_FROZEN_AUTO_INJECTION_AS_FULL";
  normalCountsAsFullReplicate: false;
  normalInstructionHash: string;
  fullInstructionHash: string;
  controlledPreseedScope: "CONDITIONAL_INJECTION_EFFECT_ONLY_NO_NATURAL_WRITE_OR_TRANSPORT_CLAIM";
  technicalRetryScope: "PER_CAUSAL_GROUP_COMPLETE_UNIT_INCLUDING_NORMAL_AND_CAUSAL_ARMS";
  preparationArtifactHash: string;
  pairSchedule: PairSchedule;
}

export interface CurrentFormalInitial6EvoPilotManifest {
  schemaVersion: "direction-a.current-formal-initial6-evo-pilot-manifest.v6";
  status: "EXACT_PRE_Y_MANIFEST_FROZEN";
  generatedAt: string;
  decisionId: "PILOT-INITIAL6-SAMPLING-V1-2026-09-05";
  experimentProgram: "CURRENT_FORMAL_PILOT";
  designBindingHash: string;
  protocolHash: string;
  budgetAuthorityHash: string;
  q6CapacityReportHash: string;
  q6ExactSealHash: string;
  q6HistoricalPreYAttestationHash: string;
  executionStateAttestationHash: string;
  oldRuntimeHaltProvenanceHash: string;
  runtimeV2HaltProvenanceHash: string;
  activeRuntimePath: typeof CURRENT_FORMAL_ACTIVE_RUNTIME_ROOT;
  executionProfileHash: string;
  productionEquivalenceEvidence: {
    path: ".research/direction-a/current-formal/pilot/reports/production-equivalence-v10.json";
    reportSha256: string;
    evidenceHash: string;
    status: "PRODUCTION_EQUIVALENCE_PASS";
  };
  gitFreezeAuditEvidence: {
    path: ".research/direction-a/current-formal/pilot/reports/git-freeze-dependency-closure-v7.json";
    reportSha256: string;
    status: "GIT_FREEZE_READY";
  };
  executionSemantics: {
    providerId: "deepseek";
    modelId: "deepseek/deepseek-v4-pro";
    scaffoldId: "HARBOR_TERMINUS_2_PINNED";
    scaffoldVersion: "terminus-2@2.0.0";
    decodingProfileId: string;
    maxTurns: 12;
    maxOutputTokens: 65536;
    technicalRetryLimit: 2;
    technicalRetryScope: "PER_CAUSAL_GROUP_COMPLETE_UNIT_INCLUDING_NORMAL_AND_CAUSAL_ARMS";
    verifierId: "evocodebench-native-case-summary";
    verifierVersion: string;
  };
  sourceFreeze: { commit: string; tag: "direction-a-current-formal-prepilot-v7" };
  policies: {
    task: typeof INITIAL6_TASK_POLICY & { selectionSeedHash: string };
    group: typeof INITIAL6_GROUP_POLICY & { selectionSeedHash: string };
    pair: typeof INITIAL6_PAIR_POLICY;
    deepReference: typeof INITIAL6_DEEP_POLICY & { selectionSeedHash: string };
  };
  selectedTasks: Initial6TaskCandidate[];
  groups: Initial6PreparedGroupManifest[];
  selectedTaskIds: string[];
  selectedStatisticalClusterIds: string[];
  selectedGroupIds: string[];
  deepReferenceGroupIds: string[];
  q6ExclusionProof: { sealedTaskIdsHash: string; overlapTaskIds: [] };
  permission: "PILOT_TRAIN_DEV";
  forbiddenPartitions: ["Q6", "CAL", "SEALED_TEST", "FORMAL_MAIN", "Q8_B1", "Q8_B2"];
  budgetForecastHash: string;
  maxPaidCalls: number;
  plannedCapCny: number;
  planningTargetCny: 100;
  monetaryLimitSemantics: "PLANNING_SOFT_TARGET_WITH_COMPLETE_GROUP_OVERSHOOT";
  allowCompleteGroupOvershoot: true;
  pricingMode: "DEEPSEEK_OFF_PEAK_ONLY";
  noAutomaticTaskExpansion: true;
  noAutomaticDeepEightToTen: true;
  contentHash: string;
}

export function buildCurrentFormalInitial6Manifest(input: {
  generatedAt: string;
  sourceFreeze: CurrentFormalInitial6EvoPilotManifest["sourceFreeze"];
  tasks: readonly Initial6TaskCandidate[];
  groupLadder: readonly Initial6GroupLadderEntry[];
  preparedGroups: readonly Initial6PreparedGroupManifest[];
  budgetForecast: Initial6CostForecast;
  profile: RealExecutionProfile;
  q6CapacityReport: Q6CapacityProxyReport;
  q6Seal: Q6HoldoutSeal;
  q6HistoricalPreYAttestation: Q6HistoricalPreYAttestation;
  executionStateAttestation: ReconciledCurrentFormalExecutionStateAttestation;
  oldRuntimeHaltProvenanceHash: string;
  runtimeV2HaltProvenanceHash: string;
  productionEquivalenceEvidence: CurrentFormalInitial6EvoPilotManifest["productionEquivalenceEvidence"];
  gitFreezeAuditEvidence: CurrentFormalInitial6EvoPilotManifest["gitFreezeAuditEvidence"];
}): CurrentFormalInitial6EvoPilotManifest {
  assertInitial6CostForecast(input.budgetForecast);
  assertRealExecutionProfile(input.profile);
  assertQ6HoldoutSeal(input.q6Seal, input.q6CapacityReport);
  assertQ6HistoricalPreYAttestation(input.q6HistoricalPreYAttestation, input.q6Seal, input.q6CapacityReport);
  assertReconciledCurrentFormalExecutionStateAttestation(input.executionStateAttestation);
  if (input.executionStateAttestation.paidCallsExecuted || input.executionStateAttestation.networkProviderCalls
    || input.executionStateAttestation.realAgentCalls || input.executionStateAttestation.realCausalYProduced
    || input.executionStateAttestation.formalCalTestConsumed || input.executionStateAttestation.sealedTestConsumed
    || input.executionStateAttestation.formalMainOpened || input.executionStateAttestation.secretContentReadEvents) throw new Error("INITIAL6_MANIFEST_REQUIRES_ZERO_PRE_EXECUTION_STATE");
  if (!Number.isFinite(Date.parse(input.generatedAt))) throw new Error("INITIAL6_MANIFEST_TIME_INVALID");
  if (!/^[a-f0-9]{64}$/.test(input.oldRuntimeHaltProvenanceHash)
    || !/^[a-f0-9]{64}$/.test(input.runtimeV2HaltProvenanceHash)) throw new Error("INITIAL6_MANIFEST_HALT_PROVENANCE_HASH_INVALID");
  if (input.sourceFreeze.tag !== "direction-a-current-formal-prepilot-v7" || !input.sourceFreeze.commit) throw new Error("INITIAL6_MANIFEST_GIT_FREEZE_INVALID");
  const selectedTasks = [...input.tasks].sort((a, b) => a.taskId.localeCompare(b.taskId));
  if (selectedTasks.length !== 6 || new Set(selectedTasks.map((row) => row.taskId)).size !== 6 || new Set(selectedTasks.map((row) => row.statisticalClusterId)).size !== 6) throw new Error("INITIAL6_MANIFEST_REQUIRES_EXACTLY_SIX_INDEPENDENT_TASKS");
  if (selectedTasks.some((row) => input.q6Seal.sealedTaskIds.includes(row.taskId))) throw new Error("INITIAL6_MANIFEST_Q6_OVERLAP");
  const selectedGroupRows = input.groupLadder.slice(0, input.budgetForecast.selectedPlan.groupCount);
  const selectedGroupIds = selectedGroupRows.map((row) => row.causalGroupId);
  if (new Set(selectedGroupIds).size !== selectedGroupIds.length || selectedGroupIds.length !== input.preparedGroups.length) throw new Error("INITIAL6_MANIFEST_GROUP_COUNT_MISMATCH");
  const preparedById = new Map(input.preparedGroups.map((row) => [row.causalGroupId, row]));
  if (selectedGroupIds.some((id) => !preparedById.has(id))) throw new Error("INITIAL6_MANIFEST_PREPARED_GROUP_MISSING");
  const anchors = selectedGroupRows.filter((row) => row.selectionRole === "RANDOM_REFERENCE_ANCHOR");
  if (anchors.length !== 6 || new Set(anchors.map((row) => row.taskId)).size !== 6) throw new Error("INITIAL6_MANIFEST_REQUIRES_ONE_ANCHOR_PER_TASK");
  const deepReferenceGroupIds = input.preparedGroups.filter((row) => row.deepReference).map((row) => row.causalGroupId).sort();
  if (deepReferenceGroupIds.length !== input.budgetForecast.selectedPlan.deepReferenceCount) throw new Error("INITIAL6_MANIFEST_DEEP_REFERENCE_COUNT_MISMATCH");
  for (const group of input.preparedGroups) {
    if (!selectedGroupIds.includes(group.causalGroupId) || !selectedTasks.some((row) => row.taskId === group.taskId)) throw new Error("INITIAL6_MANIFEST_GROUP_OUTSIDE_SELECTED_TASKS");
    if (group.deepReference ? group.validPairMaximum !== 8 || group.validPairMinimum !== 8 : group.validPairMaximum !== 5 || group.validPairMinimum !== 3) throw new Error("INITIAL6_MANIFEST_PAIR_DEPTH_MISMATCH");
    if (group.technicalRetryReserveTrials !== input.profile.environments.evo.technicalRetryLimit) throw new Error("INITIAL6_MANIFEST_RETRY_RESERVE_MISMATCH");
    if (group.normalObservationRole !== "CAUSAL_SUPERVISED_SOURCE_X"
      || group.normalTreatmentAvailability !== "SAME_FROZEN_AUTO_INJECTION_AS_FULL"
      || group.normalCountsAsFullReplicate !== false || group.normalInstructionHash !== group.fullInstructionHash) {
      throw new Error("INITIAL6_MANIFEST_NORMAL_SOURCE_X_SEMANTICS_MISMATCH");
    }
    if (group.controlledPreseedScope !== "CONDITIONAL_INJECTION_EFFECT_ONLY_NO_NATURAL_WRITE_OR_TRANSPORT_CLAIM"
      || group.technicalRetryScope !== "PER_CAUSAL_GROUP_COMPLETE_UNIT_INCLUDING_NORMAL_AND_CAUSAL_ARMS") {
      throw new Error("INITIAL6_MANIFEST_SOURCE_OR_RETRY_SCOPE_MISMATCH");
    }
    if (group.pairSchedule.rows.length !== group.validPairMaximum) throw new Error("INITIAL6_MANIFEST_PAIR_SCHEDULE_LENGTH_MISMATCH");
    if (!Number.isInteger(group.frozenTotalCases) || group.frozenTotalCases < 1) throw new Error("INITIAL6_MANIFEST_VERIFIER_DENOMINATOR_INVALID");
    if (!/^state_[a-f0-9]{24}$/.test(group.frozenPrefixHash) || !/^r0_[a-f0-9]{24}$/.test(group.recallSnapshotHash)) {
      throw new Error("INITIAL6_MANIFEST_FROZEN_IDENTITY_INVALID");
    }
    if (![group.normalTaskDirectoryHash, group.fullTaskDirectoryHash, group.removeTaskDirectoryHash].every((value) => /^[a-f0-9]{64}$/.test(value))) throw new Error("INITIAL6_MANIFEST_TASK_DIRECTORY_HASH_INVALID");
  }
  const body = {
    schemaVersion: "direction-a.current-formal-initial6-evo-pilot-manifest.v6" as const,
    status: "EXACT_PRE_Y_MANIFEST_FROZEN" as const,
    generatedAt: input.generatedAt,
    decisionId: "PILOT-INITIAL6-SAMPLING-V1-2026-09-05" as const,
    experimentProgram: "CURRENT_FORMAL_PILOT" as const,
    designBindingHash: FROZEN_DESIGN_BINDING.contentHash,
    protocolHash: FROZEN_DESIGN_BINDING.protocolHash,
    budgetAuthorityHash: INITIAL6_BUDGET_AUTHORITY.contentHash,
    q6CapacityReportHash: input.q6CapacityReport.contentHash,
    q6ExactSealHash: input.q6Seal.contentHash,
    q6HistoricalPreYAttestationHash: input.q6HistoricalPreYAttestation.contentHash,
    executionStateAttestationHash: input.executionStateAttestation.contentHash,
    oldRuntimeHaltProvenanceHash: input.oldRuntimeHaltProvenanceHash,
    runtimeV2HaltProvenanceHash: input.runtimeV2HaltProvenanceHash,
    activeRuntimePath: CURRENT_FORMAL_ACTIVE_RUNTIME_ROOT,
    executionProfileHash: input.profile.contentHash,
    productionEquivalenceEvidence: structuredClone(input.productionEquivalenceEvidence),
    gitFreezeAuditEvidence: structuredClone(input.gitFreezeAuditEvidence),
    executionSemantics: {
      providerId: "deepseek" as const,
      modelId: "deepseek/deepseek-v4-pro" as const,
      scaffoldId: "HARBOR_TERMINUS_2_PINNED" as const,
      scaffoldVersion: "terminus-2@2.0.0" as const,
      decodingProfileId: input.profile.environments.evo.decodingProfileId,
      maxTurns: 12 as const,
      maxOutputTokens: 65536 as const,
      technicalRetryLimit: 2 as const,
      technicalRetryScope: "PER_CAUSAL_GROUP_COMPLETE_UNIT_INCLUDING_NORMAL_AND_CAUSAL_ARMS" as const,
      verifierId: "evocodebench-native-case-summary" as const,
      verifierVersion: input.profile.environments.evo.verifierVersion,
    },
    sourceFreeze: structuredClone(input.sourceFreeze),
    policies: {
      task: { ...INITIAL6_TASK_POLICY, selectionSeedHash: hashCanonical(INITIAL6_TASK_POLICY) },
      group: { ...INITIAL6_GROUP_POLICY, selectionSeedHash: hashCanonical(INITIAL6_GROUP_POLICY) },
      pair: INITIAL6_PAIR_POLICY,
      deepReference: { ...INITIAL6_DEEP_POLICY, selectionSeedHash: hashCanonical(INITIAL6_DEEP_POLICY) },
    },
    selectedTasks,
    groups: selectedGroupIds.map((id) => preparedById.get(id)!),
    selectedTaskIds: selectedTasks.map((row) => row.taskId),
    selectedStatisticalClusterIds: selectedTasks.map((row) => row.statisticalClusterId).sort(),
    selectedGroupIds,
    deepReferenceGroupIds,
    q6ExclusionProof: { sealedTaskIdsHash: hashCanonical([...input.q6Seal.sealedTaskIds].sort()), overlapTaskIds: [] as [] },
    permission: "PILOT_TRAIN_DEV" as const,
    forbiddenPartitions: ["Q6", "CAL", "SEALED_TEST", "FORMAL_MAIN", "Q8_B1", "Q8_B2"] as const,
    budgetForecastHash: input.budgetForecast.contentHash,
    maxPaidCalls: input.budgetForecast.selectedPlan.maxPaidCalls,
    plannedCapCny: input.budgetForecast.selectedPlan.safetyAdjustedP95Cny,
    planningTargetCny: INITIAL6_BUDGET_AUTHORITY.planningTargetCny,
    monetaryLimitSemantics: INITIAL6_BUDGET_AUTHORITY.monetaryLimitSemantics,
    allowCompleteGroupOvershoot: true as const,
    pricingMode: "DEEPSEEK_OFF_PEAK_ONLY" as const,
    noAutomaticTaskExpansion: true as const,
    noAutomaticDeepEightToTen: true as const,
  };
  return immutableCopy({ ...body, contentHash: hashCanonical(body) }) as CurrentFormalInitial6EvoPilotManifest;
}

export function assertCurrentFormalInitial6Manifest(value: CurrentFormalInitial6EvoPilotManifest): void {
  const { contentHash, ...body } = value;
  if (hashCanonical(body) !== contentHash) throw new Error("INITIAL6_MANIFEST_HASH_MISMATCH");
  if (value.schemaVersion !== "direction-a.current-formal-initial6-evo-pilot-manifest.v6"
    || value.designBindingHash !== FROZEN_DESIGN_BINDING.contentHash || value.protocolHash !== FROZEN_DESIGN_BINDING.protocolHash
    || value.budgetAuthorityHash !== INITIAL6_BUDGET_AUTHORITY.contentHash
    || value.planningTargetCny !== INITIAL6_BUDGET_AUTHORITY.planningTargetCny
    || value.monetaryLimitSemantics !== INITIAL6_BUDGET_AUTHORITY.monetaryLimitSemantics
    || value.allowCompleteGroupOvershoot !== true || value.permission !== "PILOT_TRAIN_DEV") throw new Error("INITIAL6_MANIFEST_AUTHORITY_MISMATCH");
  if (value.selectedTasks.length !== 6 || new Set(value.selectedTaskIds).size !== 6 || value.selectedTaskIds.some((id) => !value.selectedTasks.some((row) => row.taskId === id))) throw new Error("INITIAL6_MANIFEST_TASK_SET_INVALID");
  if (value.experimentProgram !== "CURRENT_FORMAL_PILOT" || value.selectedStatisticalClusterIds.length !== 6
    || new Set(value.selectedStatisticalClusterIds).size !== 6 || value.q6ExclusionProof.overlapTaskIds.length !== 0) throw new Error("INITIAL6_MANIFEST_BOUNDARY_INVALID");
  if (value.sourceFreeze.tag !== "direction-a-current-formal-prepilot-v7" || !/^[a-f0-9]{40}$/.test(value.sourceFreeze.commit)
    || value.pricingMode !== "DEEPSEEK_OFF_PEAK_ONLY" || !value.noAutomaticTaskExpansion || !value.noAutomaticDeepEightToTen
    || hashCanonical(value.policies.task) !== hashCanonical({ ...INITIAL6_TASK_POLICY, selectionSeedHash: hashCanonical(INITIAL6_TASK_POLICY) })
    || hashCanonical(value.policies.group) !== hashCanonical({ ...INITIAL6_GROUP_POLICY, selectionSeedHash: hashCanonical(INITIAL6_GROUP_POLICY) })
    || hashCanonical(value.policies.pair) !== hashCanonical(INITIAL6_PAIR_POLICY)
    || hashCanonical(value.policies.deepReference) !== hashCanonical({ ...INITIAL6_DEEP_POLICY, selectionSeedHash: hashCanonical(INITIAL6_DEEP_POLICY) })) throw new Error("INITIAL6_MANIFEST_POLICY_OR_FREEZE_INVALID");
  if (!value.executionStateAttestationHash || !/^[a-f0-9]{64}$/.test(value.oldRuntimeHaltProvenanceHash)
    || !/^[a-f0-9]{64}$/.test(value.runtimeV2HaltProvenanceHash) || value.activeRuntimePath !== CURRENT_FORMAL_ACTIVE_RUNTIME_ROOT
    || value.executionSemantics.providerId !== "deepseek"
    || value.executionSemantics.modelId !== "deepseek/deepseek-v4-pro" || value.executionSemantics.scaffoldVersion !== "terminus-2@2.0.0"
    || value.executionSemantics.maxTurns !== 12 || value.executionSemantics.maxOutputTokens !== 65536
    || value.executionSemantics.technicalRetryLimit !== 2
    || value.executionSemantics.technicalRetryScope !== "PER_CAUSAL_GROUP_COMPLETE_UNIT_INCLUDING_NORMAL_AND_CAUSAL_ARMS"
    || value.executionSemantics.verifierId !== "evocodebench-native-case-summary") throw new Error("INITIAL6_MANIFEST_EXECUTION_SEMANTICS_INVALID");
  if (value.productionEquivalenceEvidence.path !== ".research/direction-a/current-formal/pilot/reports/production-equivalence-v10.json"
    || value.productionEquivalenceEvidence.status !== "PRODUCTION_EQUIVALENCE_PASS"
    || value.gitFreezeAuditEvidence.path !== ".research/direction-a/current-formal/pilot/reports/git-freeze-dependency-closure-v7.json"
    || value.gitFreezeAuditEvidence.status !== "GIT_FREEZE_READY"
    || ![value.productionEquivalenceEvidence.reportSha256, value.productionEquivalenceEvidence.evidenceHash,
      value.gitFreezeAuditEvidence.reportSha256].every((hash) => /^[a-f0-9]{64}$/.test(hash))) {
    throw new Error("INITIAL6_MANIFEST_SOURCE_EVIDENCE_INVALID");
  }
  if (value.groups.length !== value.selectedGroupIds.length || new Set(value.selectedGroupIds).size !== value.groups.length
    || value.groups.some((row) => !value.selectedGroupIds.includes(row.causalGroupId) || !value.selectedTaskIds.includes(row.taskId)
      || !value.selectedStatisticalClusterIds.includes(row.statisticalClusterId))) throw new Error("INITIAL6_MANIFEST_GROUP_SET_INVALID");
  const anchors = value.groups.filter((row) => row.selectionRole === "RANDOM_REFERENCE_ANCHOR");
  if (anchors.length !== 6 || new Set(anchors.map((row) => row.taskId)).size !== 6) throw new Error("INITIAL6_MANIFEST_ANCHOR_SET_INVALID");
  const deepFromGroups = value.groups.filter((row) => row.deepReference).map((row) => row.causalGroupId).sort();
  if (value.deepReferenceGroupIds.length < 2 || hashCanonical([...value.deepReferenceGroupIds].sort()) !== hashCanonical(deepFromGroups)) throw new Error("INITIAL6_MANIFEST_DEEP_SET_INVALID");
  for (const group of value.groups) {
    assertPairSchedule(group.pairSchedule);
    if (group.pairSchedule.rows.length !== group.validPairMaximum
      || (group.deepReference ? group.validPairMinimum !== 8 || group.validPairMaximum !== 8 : group.validPairMinimum !== 3 || group.validPairMaximum !== 5)
      || group.technicalRetryReserveTrials !== 2 || !Number.isInteger(group.frozenTotalCases) || group.frozenTotalCases < 1
      || group.normalObservationRole !== "CAUSAL_SUPERVISED_SOURCE_X"
      || group.normalTreatmentAvailability !== "SAME_FROZEN_AUTO_INJECTION_AS_FULL" || group.normalCountsAsFullReplicate !== false
      || group.normalInstructionHash !== group.fullInstructionHash
      || group.controlledPreseedScope !== "CONDITIONAL_INJECTION_EFFECT_ONLY_NO_NATURAL_WRITE_OR_TRANSPORT_CLAIM"
      || group.technicalRetryScope !== "PER_CAUSAL_GROUP_COMPLETE_UNIT_INCLUDING_NORMAL_AND_CAUSAL_ARMS"
      || !/^state_[a-f0-9]{24}$/.test(group.frozenPrefixHash) || !/^r0_[a-f0-9]{24}$/.test(group.recallSnapshotHash)
      || ![group.normalTaskDirectoryHash, group.fullTaskDirectoryHash, group.removeTaskDirectoryHash,
        group.targetGroupHash, group.guideNormalizationHash, group.normalInstructionHash,
        group.fullInstructionHash, group.preparationArtifactHash].every((item) => /^[a-f0-9]{64}$/.test(item))) {
      throw new Error("INITIAL6_MANIFEST_GROUP_BINDING_INVALID");
    }
  }
  const derivedMaxPaidCalls = value.groups.reduce((sum, group) => sum + (1 + 2 * group.validPairMaximum + group.technicalRetryReserveTrials) * value.executionSemantics.maxTurns, 0);
  if (!(value.plannedCapCny <= value.planningTargetCny) || value.plannedCapCny <= 0
    || !Number.isInteger(value.maxPaidCalls) || value.maxPaidCalls !== derivedMaxPaidCalls) throw new Error("INITIAL6_MANIFEST_BUDGET_INVALID");
}
