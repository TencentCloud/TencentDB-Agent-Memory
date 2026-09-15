import { hashCanonical, immutableCopy, sha256 } from "../core/canonical.js";
import { assertQ6HoldoutSeal, type Q6HoldoutSeal } from "../prepilot/q6-holdout-seal.js";
import { assertLabelBlindInput } from "../core/integrity.js";

export const INITIAL6_TASK_POLICY = {
  policyId: "direction-a.evo-initial6-task-selection",
  policyVersion: "direction-a.evo-initial6-task-selection.v1",
  selectionSeed: "direction-a-evo-initial6-task-selection-2026-09-05-v1",
} as const;
export const INITIAL6_GROUP_POLICY = {
  policyId: "direction-a.evo-initial6-group-acquisition",
  policyVersion: "direction-a.evo-initial6-group-acquisition.v1",
  selectionSeed: "direction-a-evo-initial6-group-selection-2026-09-05-v1",
} as const;
export const INITIAL6_DEEP_POLICY = {
  policyId: "direction-a.evo-initial6-deep-reference",
  policyVersion: "direction-a.evo-initial6-deep-reference.v1",
  selectionSeed: "direction-a-evo-initial6-deep-reference-2026-09-05-v1",
} as const;
export const INITIAL6_PAIR_POLICY = {
  policyId: "direction-a.evo-pilot-pair-ladder",
  policyVersion: "direction-a.evo-pilot-pair-ladder.consensus-3-4-5.v1",
  ordinaryMinimumPairs: 3,
  ordinaryMaximumPairs: 5,
  deepPairs: 8,
} as const;

export interface Initial6TaskCandidate {
  taskId: string;
  statisticalClusterId: string;
  officialDomainId: string;
  metadataName: string;
  category: string;
  numberOfRounds: number;
  eligibleCausalGroupCount: number;
  sourceTaskPath: string;
  sourceTaskDirectoryHash: string;
  technicalEligible: boolean;
  executorCapable: boolean;
  verifierCapable: boolean;
  normalRunCheapXAvailable: boolean;
  processTelemetryAvailable: boolean;
  provenanceIntegrityAvailable: boolean;
  permission: "PILOT_TRAIN_DEV";
  expectedTrialCostUpperCny: number;
  candidateHash: string;
}

export interface Initial6GroupCandidate {
  causalGroupId: string;
  taskId: string;
  statisticalClusterId: string;
  officialDomainId: string;
  targetRound: number;
  sourceMemoryRound: number;
  changeTypes: string[];
  technicalEligible: boolean;
  normalRunCheapXAvailable: boolean;
  processTelemetryAvailable: boolean;
  provenanceIntegrityAvailable: boolean;
  permission: "PILOT_TRAIN_DEV";
  expectedTrialCostUpperCny: number;
  sourceEvidenceHash: string;
  candidateHash: string;
}

export interface Initial6TaskSelection {
  policy: typeof INITIAL6_TASK_POLICY & { selectionSeedHash: string };
  selectedTasks: Initial6TaskCandidate[];
  selectedTaskIds: string[];
  structuralBreadth: { officialDomains: number; categories: number };
  eligibleCausalGroupCapacity: number;
  conservativeTrialCostUpperCny: number;
  selectionHash: string;
}

function assertTaskCandidate(row: Initial6TaskCandidate): void {
  assertLabelBlindInput(row);
  const { candidateHash, ...body } = row;
  if (candidateHash !== hashCanonical({ policy: INITIAL6_TASK_POLICY, ...body })) throw new Error(`INITIAL6_TASK_CANDIDATE_HASH_MISMATCH:${row.taskId}`);
  if (!row.taskId || row.statisticalClusterId !== row.taskId || !row.officialDomainId || row.permission !== "PILOT_TRAIN_DEV"
    || !Number.isInteger(row.eligibleCausalGroupCount) || row.eligibleCausalGroupCount < 0
    || !Number.isFinite(row.expectedTrialCostUpperCny) || row.expectedTrialCostUpperCny <= 0) throw new Error(`INITIAL6_TASK_CANDIDATE_INVALID:${row.taskId}`);
}

function assertGroupCandidate(row: Initial6GroupCandidate): void {
  assertLabelBlindInput(row);
  const { candidateHash, ...body } = row;
  if (candidateHash !== hashCanonical({ policy: INITIAL6_GROUP_POLICY, ...body })) throw new Error(`INITIAL6_GROUP_CANDIDATE_HASH_MISMATCH:${row.causalGroupId}`);
  if (!row.causalGroupId || !row.taskId || row.statisticalClusterId !== row.taskId || row.permission !== "PILOT_TRAIN_DEV"
    || !Number.isInteger(row.targetRound) || row.targetRound < 2 || row.sourceMemoryRound !== row.targetRound - 1
    || !row.sourceEvidenceHash || !Number.isFinite(row.expectedTrialCostUpperCny) || row.expectedTrialCostUpperCny <= 0) throw new Error(`INITIAL6_GROUP_CANDIDATE_INVALID:${row.causalGroupId}`);
}

export function assertInitial6TaskSelection(value: Initial6TaskSelection): void {
  if (hashCanonical(INITIAL6_TASK_POLICY) !== value.policy.selectionSeedHash
    || value.policy.policyId !== INITIAL6_TASK_POLICY.policyId
    || value.policy.policyVersion !== INITIAL6_TASK_POLICY.policyVersion
    || value.policy.selectionSeed !== INITIAL6_TASK_POLICY.selectionSeed) throw new Error("INITIAL6_TASK_SELECTION_POLICY_MISMATCH");
  value.selectedTasks.forEach(assertTaskCandidate);
  const { selectionHash, ...body } = value;
  if (hashCanonical(body) !== selectionHash) throw new Error("INITIAL6_TASK_SELECTION_HASH_MISMATCH");
  if (value.selectedTasks.length !== 6 || new Set(value.selectedTaskIds).size !== 6
    || hashCanonical([...value.selectedTaskIds].sort()) !== hashCanonical(value.selectedTasks.map((row) => row.taskId).sort())) throw new Error("INITIAL6_TASK_SELECTION_REQUIRES_EXACTLY_SIX");
}

function compareSetObjective(a: Initial6TaskCandidate[], b: Initial6TaskCandidate[]): number {
  const domainA = new Set(a.map((row) => row.officialDomainId)).size;
  const domainB = new Set(b.map((row) => row.officialDomainId)).size;
  if (domainA !== domainB) return domainB - domainA;
  const categoryA = new Set(a.map((row) => row.category)).size;
  const categoryB = new Set(b.map((row) => row.category)).size;
  if (categoryA !== categoryB) return categoryB - categoryA;
  const capacityA = a.reduce((sum, row) => sum + row.eligibleCausalGroupCount, 0);
  const capacityB = b.reduce((sum, row) => sum + row.eligibleCausalGroupCount, 0);
  if (capacityA !== capacityB) return capacityB - capacityA;
  const usableA = a.reduce((sum, row) => sum + Number(row.normalRunCheapXAvailable) + Number(row.processTelemetryAvailable), 0);
  const usableB = b.reduce((sum, row) => sum + Number(row.normalRunCheapXAvailable) + Number(row.processTelemetryAvailable), 0);
  if (usableA !== usableB) return usableB - usableA;
  const costA = a.reduce((sum, row) => sum + row.expectedTrialCostUpperCny, 0);
  const costB = b.reduce((sum, row) => sum + row.expectedTrialCostUpperCny, 0);
  if (costA !== costB) return costA - costB;
  const setHash = (rows: Initial6TaskCandidate[]) => sha256(`${INITIAL6_TASK_POLICY.policyId}\0${INITIAL6_TASK_POLICY.policyVersion}\0${INITIAL6_TASK_POLICY.selectionSeed}\0${rows.map((row) => row.candidateHash).sort().join("\0")}`);
  return setHash(a).localeCompare(setHash(b));
}

export function selectInitial6Tasks(candidates: readonly Initial6TaskCandidate[], q6Seal: Q6HoldoutSeal): Initial6TaskSelection {
  assertQ6HoldoutSeal(q6Seal);
  candidates.forEach(assertTaskCandidate);
  const eligible = candidates.filter((row) => row.technicalEligible && row.executorCapable && row.verifierCapable && row.normalRunCheapXAvailable
    && row.processTelemetryAvailable && row.provenanceIntegrityAvailable && row.permission === "PILOT_TRAIN_DEV" && row.eligibleCausalGroupCount > 0
    && !q6Seal.sealedTaskIds.includes(row.taskId));
  if (new Set(eligible.map((row) => row.taskId)).size !== eligible.length || new Set(eligible.map((row) => row.statisticalClusterId)).size !== eligible.length) throw new Error("INITIAL6_TASK_CANDIDATE_IDENTITY_DUPLICATE");
  if (eligible.length < 6) throw new Error("CORE_DECISION_REQUIRED:INITIAL6_TASK_METADATA_INSUFFICIENT");
  let best: Initial6TaskCandidate[] | undefined;
  const visit = (start: number, picked: Initial6TaskCandidate[]): void => {
    if (picked.length === 6) { if (!best || compareSetObjective(picked, best) < 0) best = [...picked]; return; }
    for (let index = start; index <= eligible.length - (6 - picked.length); index += 1) visit(index + 1, [...picked, eligible[index]]);
  };
  visit(0, []);
  const selectedTasks = best!.sort((a, b) => a.taskId.localeCompare(b.taskId));
  const policy = { ...INITIAL6_TASK_POLICY, selectionSeedHash: hashCanonical(INITIAL6_TASK_POLICY) };
  const body = { policy, selectedTasks, selectedTaskIds: selectedTasks.map((row) => row.taskId), structuralBreadth: {
    officialDomains: new Set(selectedTasks.map((row) => row.officialDomainId)).size,
    categories: new Set(selectedTasks.map((row) => row.category)).size,
  }, eligibleCausalGroupCapacity: selectedTasks.reduce((sum, row) => sum + row.eligibleCausalGroupCount, 0),
  conservativeTrialCostUpperCny: selectedTasks.reduce((sum, row) => sum + row.expectedTrialCostUpperCny, 0) };
  return immutableCopy({ ...body, selectionHash: hashCanonical(body) }) as Initial6TaskSelection;
}

export interface Initial6GroupLadderEntry extends Initial6GroupCandidate {
  ladderIndex: number;
  selectionRole: "RANDOM_REFERENCE_ANCHOR" | "ACTIVE";
  randomReferenceProbability: number;
  randomizedInclusionProbability: number | "NOT_RANDOMIZED";
  randomOrderHash: string;
  activeSelectionProvenance: string | "NOT_ACTIVE";
}

function groupSeedHash(group: Initial6GroupCandidate, purpose: string): string {
  return sha256(`${INITIAL6_GROUP_POLICY.policyId}\0${INITIAL6_GROUP_POLICY.policyVersion}\0${INITIAL6_GROUP_POLICY.selectionSeed}\0${purpose}\0${group.taskId}\0${group.causalGroupId}`);
}

export function buildInitial6GroupLadder(taskSelection: Initial6TaskSelection, groups: readonly Initial6GroupCandidate[]): Initial6GroupLadderEntry[] {
  assertInitial6TaskSelection(taskSelection);
  groups.forEach(assertGroupCandidate);
  if (new Set(groups.map((row) => row.causalGroupId)).size !== groups.length) throw new Error("INITIAL6_GROUP_CANDIDATE_IDENTITY_DUPLICATE");
  const taskIds = new Set(taskSelection.selectedTaskIds);
  const eligible = groups.filter((row) => taskIds.has(row.taskId) && row.technicalEligible && row.normalRunCheapXAvailable
    && row.processTelemetryAvailable && row.provenanceIntegrityAvailable && row.permission === "PILOT_TRAIN_DEV");
  const byTask = new Map<string, Initial6GroupCandidate[]>();
  taskSelection.selectedTaskIds.forEach((taskId) => byTask.set(taskId, []));
  eligible.forEach((row) => byTask.get(row.taskId)!.push(row));
  if ([...byTask].some(([, rows]) => rows.length === 0)) throw new Error("CORE_DECISION_REQUIRED:GROUP_ACQUISITION_METADATA_INSUFFICIENT:task_has_no_legal_group");
  const selectedIds = new Set<string>();
  const ladder: Initial6GroupLadderEntry[] = [];
  for (const taskId of taskSelection.selectedTaskIds) {
    const rows = byTask.get(taskId)!.map((row) => ({ row, hash: groupSeedHash(row, "anchor") })).sort((a, b) => a.hash.localeCompare(b.hash) || a.row.causalGroupId.localeCompare(b.row.causalGroupId));
    const winner = rows[0]; selectedIds.add(winner.row.causalGroupId);
    ladder.push({ ...winner.row, ladderIndex: ladder.length + 1, selectionRole: "RANDOM_REFERENCE_ANCHOR", randomReferenceProbability: 1 / rows.length,
      randomizedInclusionProbability: 1 / rows.length, randomOrderHash: winner.hash, activeSelectionProvenance: "NOT_ACTIVE" });
  }
  const selectedChangeTypes = new Set(ladder.flatMap((row) => row.changeTypes));
  const selectedSignatures = new Map<string, number>();
  ladder.forEach((row) => { const signature = [...row.changeTypes].sort().join("+"); selectedSignatures.set(signature, (selectedSignatures.get(signature) ?? 0) + 1); });
  const selectedPerTask = new Map(taskSelection.selectedTaskIds.map((taskId) => [taskId, 1]));
  while (selectedIds.size < eligible.length) {
    const remaining = eligible.filter((row) => !selectedIds.has(row.causalGroupId));
    remaining.sort((a, b) => {
      const newTypesA = new Set(a.changeTypes.filter((value) => !selectedChangeTypes.has(value))).size;
      const newTypesB = new Set(b.changeTypes.filter((value) => !selectedChangeTypes.has(value))).size;
      if (newTypesA !== newTypesB) return newTypesB - newTypesA;
      const taskCountA = selectedPerTask.get(a.taskId) ?? 0; const taskCountB = selectedPerTask.get(b.taskId) ?? 0;
      if (taskCountA !== taskCountB) return taskCountA - taskCountB;
      const signatureA = [...a.changeTypes].sort().join("+"); const signatureB = [...b.changeTypes].sort().join("+");
      const redundancyA = selectedSignatures.get(signatureA) ?? 0; const redundancyB = selectedSignatures.get(signatureB) ?? 0;
      if (redundancyA !== redundancyB) return redundancyA - redundancyB;
      if (a.expectedTrialCostUpperCny !== b.expectedTrialCostUpperCny) return a.expectedTrialCostUpperCny - b.expectedTrialCostUpperCny;
      return groupSeedHash(a, "active").localeCompare(groupSeedHash(b, "active")) || a.causalGroupId.localeCompare(b.causalGroupId);
    });
    const winner = remaining[0]; selectedIds.add(winner.causalGroupId);
    winner.changeTypes.forEach((value) => selectedChangeTypes.add(value));
    const signature = [...winner.changeTypes].sort().join("+"); selectedSignatures.set(signature, (selectedSignatures.get(signature) ?? 0) + 1);
    selectedPerTask.set(winner.taskId, (selectedPerTask.get(winner.taskId) ?? 0) + 1);
    const randomOrderHash = groupSeedHash(winner, "active");
    ladder.push({ ...winner, ladderIndex: ladder.length + 1, selectionRole: "ACTIVE", randomReferenceProbability: 1 / byTask.get(winner.taskId)!.length,
      randomizedInclusionProbability: "NOT_RANDOMIZED", randomOrderHash,
      activeSelectionProvenance: hashCanonical({ policy: INITIAL6_GROUP_POLICY, frozenCandidate: winner, lexicographicPosition: ladder.length + 1 }) });
  }
  return immutableCopy(ladder) as Initial6GroupLadderEntry[];
}

export function selectDeepReferenceGroups(selectedGroups: readonly Initial6GroupLadderEntry[], deepCount: 2 | 3 | 4 | 6): string[] {
  if (selectedGroups.length < deepCount) throw new Error("DEEP_REFERENCE_COUNT_EXCEEDS_SELECTED_GROUPS");
  const byTask = new Map<string, Initial6GroupLadderEntry[]>();
  selectedGroups.forEach((row) => byTask.set(row.taskId, [...(byTask.get(row.taskId) ?? []), row]));
  const orderedTasks = [...byTask].map(([taskId, rows]) => ({ taskId, rows: rows.sort((a, b) => sha256(`${INITIAL6_DEEP_POLICY.selectionSeed}\0${a.causalGroupId}`).localeCompare(sha256(`${INITIAL6_DEEP_POLICY.selectionSeed}\0${b.causalGroupId}`))),
    hash: sha256(`${INITIAL6_DEEP_POLICY.policyId}\0${INITIAL6_DEEP_POLICY.policyVersion}\0${INITIAL6_DEEP_POLICY.selectionSeed}\0${taskId}`) }))
    .sort((a, b) => a.hash.localeCompare(b.hash) || a.taskId.localeCompare(b.taskId));
  const output: string[] = [];
  for (let depth = 0; output.length < deepCount; depth += 1) {
    for (const task of orderedTasks) if (task.rows[depth] && output.length < deepCount) output.push(task.rows[depth].causalGroupId);
  }
  return output;
}
