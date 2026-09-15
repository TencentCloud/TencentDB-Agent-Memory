import { hashCanonical, immutableCopy } from "../core/canonical.js";
import { assertLabelBlindInput } from "../core/integrity.js";
import { FROZEN_DESIGN_BINDING } from "../config/frozen-design.js";

export interface Q6PrepilotTaskMetadata {
  taskId: string;
  officialDomainId: string;
  independentTaskId: string;
  verifierCapable: boolean;
  executorCapable: boolean;
  normalRunCheapXAvailable: boolean;
  processEvidenceAvailable: boolean;
  provenanceIntegrityPass: boolean;
  expectedCausalCostCnyRange: readonly [number, number] | "UNAVAILABLE";
}

export interface Q6ProtectedEaAllocation {
  pilotIndependentTaskClusters: 8;
  calFreshTaskClusters: 5;
  sealedTestFreshTaskClusters: 5;
  trainDevReserveBasis: "EXACT_PREALLOCATED_TASK_IDS" | "NO_NUMERIC_FLOOR_FROZEN";
  trainDevTaskIds: string[];
}

export interface Q6DomainFeasibility {
  officialDomainId: string;
  heldOutIndependentTaskIds: string[];
  heldOutIndependentTaskCount: number;
  remainingIndependentTaskCount: number;
  heldOutCapabilityPass: boolean;
  protectedEaReservePass: boolean;
  feasibilityStatus: "FEASIBLE_PENDING_RESEARCHER_DOMAIN_RULE" | "NOT_FEASIBLE";
  reasons: string[];
}

export interface Q6CapacityProxyReport {
  schemaVersion: "direction-a.q3-prepilot-domain-capacity-proxy.v2";
  proxyPolicyVersion: "direction-a.q6-capacity-label-blind.v1";
  designBindingHash: string;
  protocolHash: string;
  inputTaxonomyHash: string;
  sourceEvidence: {
    officialTaskManifestHash: string;
    supplementalTaskArtifactFilenameSetHash: string;
    environmentSignatureHash: string;
    budgetFreezeHash: string;
    readPolicy: "NO_RESULT_OR_LABEL_CONTENT_READ";
  };
  independentTaskCount: number;
  protectedEaAllocation: Q6ProtectedEaAllocation;
  candidates: Q6DomainFeasibility[];
  exactSealDisposition:
    | "CORE_DECISION_REQUIRED_NO_FROZEN_DOMAIN_TIEBREAK"
    | "Q6_DOMAIN_LEVEL_INFEASIBLE_PREPILOT"
    | "READY_FOR_EXPLICIT_FROZEN_SELECTION";
  contentHash: string;
}

export const Q6_FROZEN_SELECTION_POLICY_VERSION = "direction-a.q6.max-heldout-breadth-then-hash.v1" as const;
export const Q6_FROZEN_SELECTION_SEED = "direction-a-q6-heldout-tiebreak-2026-09-05-v1" as const;
export const Q6_FROZEN_SELECTION_DECISION_ID = "Q6-MAX-HELDOUT-BREADTH-V1-2026-09-05" as const;

export interface Q6PreYExecutionState {
  paidCallsExecuted: number;
  networkProviderCalls: number;
  realAgentCalls: number;
  realCausalYProduced: number;
  formalCalTestConsumed: number;
  sealedTestConsumed: number;
  formalMainOpened: boolean;
}

export interface Q6FrozenDomainSelection {
  schemaVersion: "direction-a.q6-frozen-domain-selection.v1";
  selectedOfficialDomainId: string;
  heldOutIndependentTaskCount: number;
  policyVersion: typeof Q6_FROZEN_SELECTION_POLICY_VERSION;
  seed: typeof Q6_FROZEN_SELECTION_SEED;
  tieBreakTriggered: boolean;
  tiedMaxBreadthOfficialDomainIds: string[];
  selectedCandidatePriorityHash: string;
  capacityReportHash: string;
  selectionHash: string;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function assertQ6PreYExecutionState(state: Q6PreYExecutionState): void {
  const nonzero = Object.entries(state).filter(([, value]) => value !== 0 && value !== false);
  if (nonzero.length) throw new Error(`Q6_PRE_Y_EXECUTION_STATE_NOT_ZERO:${nonzero.map(([key]) => key).join(",")}`);
}

export function assertQ6CapacityProxyReport(report: Q6CapacityProxyReport): void {
  const { contentHash, ...body } = report;
  if (hashCanonical(body) !== contentHash) throw new Error("Q6 capacity report hash mismatch");
  if (report.designBindingHash !== FROZEN_DESIGN_BINDING.contentHash || report.protocolHash !== FROZEN_DESIGN_BINDING.protocolHash) {
    throw new Error("Q6 capacity report authority hash mismatch");
  }
  assertLabelBlindInput(report);
}

function q6CandidatePriorityHash(officialDomainId: string): string {
  return hashCanonical({
    policyVersion: Q6_FROZEN_SELECTION_POLICY_VERSION,
    seed: Q6_FROZEN_SELECTION_SEED,
    officialDomainId,
  });
}

export function selectQ6HoldoutDomainByFrozenPolicy(report: Q6CapacityProxyReport): Q6FrozenDomainSelection {
  assertQ6CapacityProxyReport(report);
  const feasible = report.candidates.filter((row) => row.feasibilityStatus === "FEASIBLE_PENDING_RESEARCHER_DOMAIN_RULE");
  if (!feasible.length) throw new Error("Q6_DOMAIN_LEVEL_INFEASIBLE_PREPILOT");
  const maxBreadth = Math.max(...feasible.map((row) => row.heldOutIndependentTaskCount));
  const tied = feasible.filter((row) => row.heldOutIndependentTaskCount === maxBreadth)
    .map((row) => ({ row, priorityHash: q6CandidatePriorityHash(row.officialDomainId) }))
    .sort((a, b) => a.priorityHash.localeCompare(b.priorityHash) || a.row.officialDomainId.localeCompare(b.row.officialDomainId));
  const winner = tied[0];
  const body = {
    schemaVersion: "direction-a.q6-frozen-domain-selection.v1" as const,
    selectedOfficialDomainId: winner.row.officialDomainId,
    heldOutIndependentTaskCount: winner.row.heldOutIndependentTaskCount,
    policyVersion: Q6_FROZEN_SELECTION_POLICY_VERSION,
    seed: Q6_FROZEN_SELECTION_SEED,
    tieBreakTriggered: tied.length > 1,
    tiedMaxBreadthOfficialDomainIds: tied.map(({ row }) => row.officialDomainId).sort(),
    selectedCandidatePriorityHash: winner.priorityHash,
    capacityReportHash: report.contentHash,
  };
  return immutableCopy({ ...body, selectionHash: hashCanonical(body) }) as Q6FrozenDomainSelection;
}

export function buildQ3PrepilotDomainCapacityProxy(input: {
  tasks: readonly Q6PrepilotTaskMetadata[];
  protectedEaAllocation: Q6ProtectedEaAllocation;
  sourceEvidence: Q6CapacityProxyReport["sourceEvidence"];
}): Q6CapacityProxyReport {
  assertLabelBlindInput(input);
  if (!input.tasks.length) throw new Error("Q6 capacity proxy requires official task taxonomy metadata");
  if (input.sourceEvidence.readPolicy !== "NO_RESULT_OR_LABEL_CONTENT_READ"
    || Object.entries(input.sourceEvidence).some(([key, value]) => key !== "readPolicy" && !value)) throw new Error("Q6 capacity proxy requires complete label-blind source evidence hashes");
  if (input.protectedEaAllocation.pilotIndependentTaskClusters !== FROZEN_DESIGN_BINDING.evoPilot.hardMaximumIndependentTaskClusters
    || input.protectedEaAllocation.calFreshTaskClusters !== FROZEN_DESIGN_BINDING.structuralFreshTaskFloors.cal
    || input.protectedEaAllocation.sealedTestFreshTaskClusters !== FROZEN_DESIGN_BINDING.structuralFreshTaskFloors.sealedTest) {
    throw new Error("Q6 reserve counts differ from the frozen Pilot/CAL/SEALED_TEST structural requirements");
  }
  if (unique(input.protectedEaAllocation.trainDevTaskIds).length !== input.protectedEaAllocation.trainDevTaskIds.length) throw new Error("TRAIN/DEV task reserve contains duplicates");
  if (input.protectedEaAllocation.trainDevReserveBasis === "NO_NUMERIC_FLOOR_FROZEN" && input.protectedEaAllocation.trainDevTaskIds.length) throw new Error("TRAIN/DEV task IDs contradict NO_NUMERIC_FLOOR_FROZEN");
  const taskIds = unique(input.tasks.map((row) => row.taskId));
  const independentIds = unique(input.tasks.map((row) => row.independentTaskId));
  if (taskIds.length !== input.tasks.length || independentIds.length !== input.tasks.length) {
    throw new Error("Q6 capacity counts complete independent tasks; duplicate task/round identities are forbidden");
  }
  for (const row of input.tasks) {
    if (!row.taskId || !row.officialDomainId || !row.independentTaskId) throw new Error("Q6 taxonomy identities must be non-empty");
    if (row.expectedCausalCostCnyRange !== "UNAVAILABLE") {
      const [low, high] = row.expectedCausalCostCnyRange;
      if (!Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high < low) throw new Error(`Invalid cost range for ${row.taskId}`);
    }
  }
  const requiredKnownReserve = FROZEN_DESIGN_BINDING.evoPilot.hardMaximumIndependentTaskClusters
    + FROZEN_DESIGN_BINDING.structuralFreshTaskFloors.cal
    + FROZEN_DESIGN_BINDING.structuralFreshTaskFloors.sealedTest;
  const domains = unique(input.tasks.map((row) => row.officialDomainId));
  const candidates = domains.map((officialDomainId): Q6DomainFeasibility => {
    const heldOut = input.tasks.filter((row) => row.officialDomainId === officialDomainId);
    const heldIds = unique(heldOut.map((row) => row.independentTaskId));
    const remaining = input.tasks.filter((row) => row.officialDomainId !== officialDomainId);
    const remainingIds = new Set(remaining.map((row) => row.independentTaskId));
    const reasons: string[] = [];
    const heldOutCapabilityPass = heldOut.every((row) => row.verifierCapable && row.executorCapable && row.normalRunCheapXAvailable
      && row.processEvidenceAvailable && row.provenanceIntegrityPass && row.expectedCausalCostCnyRange !== "UNAVAILABLE");
    if (!heldOutCapabilityPass) reasons.push("HELD_OUT_CAPABILITY_OR_PROVENANCE_NOT_READY");
    const missingTrainDevTasks = input.protectedEaAllocation.trainDevTaskIds.filter((id) => !remainingIds.has(id));
    const requiredRemainingCount = requiredKnownReserve + input.protectedEaAllocation.trainDevTaskIds.length;
    const protectedEaReservePass = missingTrainDevTasks.length === 0 && remainingIds.size >= requiredRemainingCount;
    if (missingTrainDevTasks.length) reasons.push(`REQUIRED_TRAIN_DEV_TASKS_INSIDE_DOMAIN:${missingTrainDevTasks.join(",")}`);
    if (remainingIds.size < requiredRemainingCount) reasons.push(`REMAINING_CAPACITY_${remainingIds.size}_BELOW_FROZEN_STRUCTURAL_RESERVE_${requiredRemainingCount}`);
    return {
      officialDomainId,
      heldOutIndependentTaskIds: heldIds,
      heldOutIndependentTaskCount: heldIds.length,
      remainingIndependentTaskCount: remainingIds.size,
      heldOutCapabilityPass,
      protectedEaReservePass,
      feasibilityStatus: reasons.length ? "NOT_FEASIBLE" : "FEASIBLE_PENDING_RESEARCHER_DOMAIN_RULE",
      reasons,
    };
  });
  const feasible = candidates.filter((row) => row.feasibilityStatus === "FEASIBLE_PENDING_RESEARCHER_DOMAIN_RULE");
  const body = {
    schemaVersion: "direction-a.q3-prepilot-domain-capacity-proxy.v2" as const,
    proxyPolicyVersion: "direction-a.q6-capacity-label-blind.v1" as const,
    designBindingHash: FROZEN_DESIGN_BINDING.contentHash,
    protocolHash: FROZEN_DESIGN_BINDING.protocolHash,
    inputTaxonomyHash: hashCanonical(input.tasks),
    sourceEvidence: structuredClone(input.sourceEvidence),
    independentTaskCount: independentIds.length,
    protectedEaAllocation: structuredClone(input.protectedEaAllocation),
    candidates,
    exactSealDisposition: feasible.length === 0 ? "Q6_DOMAIN_LEVEL_INFEASIBLE_PREPILOT" as const
      : feasible.length === 1 ? "READY_FOR_EXPLICIT_FROZEN_SELECTION" as const
      : "CORE_DECISION_REQUIRED_NO_FROZEN_DOMAIN_TIEBREAK" as const,
  };
  return immutableCopy({ ...body, contentHash: hashCanonical(body) }) as Q6CapacityProxyReport;
}

export interface Q6HoldoutSeal {
  schemaVersion: "direction-a.q6-holdout-seal.v1";
  officialDomainId: string;
  sealedTaskIds: string[];
  proxyPolicyVersion: Q6CapacityProxyReport["proxyPolicyVersion"];
  capacityReportHash: string;
  selectionProvenance: {
    kind: "FROZEN_DETERMINISTIC_PRIORITY";
    decisionId: typeof Q6_FROZEN_SELECTION_DECISION_ID;
    decidedAt: string;
    seed: typeof Q6_FROZEN_SELECTION_SEED;
    tieBreakPolicyVersion: typeof Q6_FROZEN_SELECTION_POLICY_VERSION;
    deterministicSelectionHash: string;
    tieBreakTriggered: boolean;
    heldOutIndependentTaskCount: number;
    causalYProducedBeforeDecision: false;
  };
  designBindingHash: string;
  protocolHash: string;
  contentHash: string;
}

export function finalizeQ6HoldoutSeal(report: Q6CapacityProxyReport, input: {
  decidedAt: string;
  preYExecutionState: Q6PreYExecutionState;
  suppliedOfficialDomainId?: string;
}): Q6HoldoutSeal {
  assertQ6PreYExecutionState(input.preYExecutionState);
  if (!input.decidedAt || !Number.isFinite(Date.parse(input.decidedAt))) throw new Error("Exact Q6 seal requires a real ISO-8601 pre-Y decision timestamp");
  const deterministicSelection = selectQ6HoldoutDomainByFrozenPolicy(report);
  if (input.suppliedOfficialDomainId && input.suppliedOfficialDomainId !== deterministicSelection.selectedOfficialDomainId) {
    throw new Error("Q6_DOMAIN_DIFFERS_FROM_FROZEN_SELECTION_POLICY");
  }
  const officialDomainId = deterministicSelection.selectedOfficialDomainId;
  const candidate = report.candidates.find((row) => row.officialDomainId === officialDomainId);
  if (!candidate || candidate.feasibilityStatus !== "FEASIBLE_PENDING_RESEARCHER_DOMAIN_RULE") throw new Error(`Q6 domain ${officialDomainId} is not feasible`);
  const selectionProvenance: Q6HoldoutSeal["selectionProvenance"] = {
    kind: "FROZEN_DETERMINISTIC_PRIORITY",
    decisionId: Q6_FROZEN_SELECTION_DECISION_ID,
    decidedAt: input.decidedAt,
    seed: Q6_FROZEN_SELECTION_SEED,
    tieBreakPolicyVersion: Q6_FROZEN_SELECTION_POLICY_VERSION,
    deterministicSelectionHash: deterministicSelection.selectionHash,
    tieBreakTriggered: deterministicSelection.tieBreakTriggered,
    heldOutIndependentTaskCount: deterministicSelection.heldOutIndependentTaskCount,
    causalYProducedBeforeDecision: false,
  };
  const body = {
    schemaVersion: "direction-a.q6-holdout-seal.v1" as const,
    officialDomainId,
    sealedTaskIds: [...candidate.heldOutIndependentTaskIds].sort(),
    proxyPolicyVersion: report.proxyPolicyVersion,
    capacityReportHash: report.contentHash,
    selectionProvenance,
    designBindingHash: report.designBindingHash,
    protocolHash: report.protocolHash,
  };
  return immutableCopy({ ...body, contentHash: hashCanonical(body) }) as Q6HoldoutSeal;
}

export function assertQ6HoldoutSeal(seal: Q6HoldoutSeal, report?: Q6CapacityProxyReport): void {
  const { contentHash, ...body } = seal;
  if (hashCanonical(body) !== contentHash) throw new Error("Q6_HOLDOUT_SEAL content hash mismatch");
  if (seal.designBindingHash !== FROZEN_DESIGN_BINDING.contentHash || seal.protocolHash !== FROZEN_DESIGN_BINDING.protocolHash) throw new Error("Q6_HOLDOUT_SEAL authority hash mismatch");
  const provenance = seal.selectionProvenance;
  if (provenance.kind !== "FROZEN_DETERMINISTIC_PRIORITY"
    || provenance.decisionId !== Q6_FROZEN_SELECTION_DECISION_ID
    || provenance.seed !== Q6_FROZEN_SELECTION_SEED
    || provenance.tieBreakPolicyVersion !== Q6_FROZEN_SELECTION_POLICY_VERSION
    || provenance.causalYProducedBeforeDecision !== false) {
    throw new Error("Q6_HOLDOUT_SEAL frozen selection provenance mismatch");
  }
  if (!provenance.decidedAt || !Number.isFinite(Date.parse(provenance.decidedAt))) throw new Error("Q6_HOLDOUT_SEAL decision timestamp invalid");
  if (report) {
    const selection = selectQ6HoldoutDomainByFrozenPolicy(report);
    const candidate = report.candidates.find((row) => row.officialDomainId === selection.selectedOfficialDomainId)!;
    if (seal.capacityReportHash !== report.contentHash
      || seal.officialDomainId !== selection.selectedOfficialDomainId
      || provenance.deterministicSelectionHash !== selection.selectionHash
      || provenance.tieBreakTriggered !== selection.tieBreakTriggered
      || provenance.heldOutIndependentTaskCount !== selection.heldOutIndependentTaskCount
      || hashCanonical([...seal.sealedTaskIds].sort()) !== hashCanonical([...candidate.heldOutIndependentTaskIds].sort())) {
      throw new Error("Q6_HOLDOUT_SEAL differs from frozen selection policy or capacity report");
    }
  }
}

export function assertTaskNotQ6Sealed(taskId: string, seal: Q6HoldoutSeal): void {
  assertQ6HoldoutSeal(seal);
  if (seal.sealedTaskIds.includes(taskId)) throw new Error(`Q6_SEALED_TASK_FORBIDDEN:${taskId}`);
}
