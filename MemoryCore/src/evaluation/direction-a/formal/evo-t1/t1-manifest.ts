import { hashCanonical, immutableCopy } from "../core/canonical.js";
import type { Initial6PreparedGroupManifest } from "../pilot/initial6-manifest.js";
import { assertPairSchedule } from "../acquisition/integrity.js";

export const T1_DECISION_ID = "EVO_ENGINEERING_FIRST_BUDGET100_V1_2026_09_12" as const;
export const T1_TASK_IDS = [
  "theme_d6_w1_database_storage_greenfield_implementation",
  "theme_d3_w9_testing_quality_reproducibility_verification",
] as const;
export const T1_GROUP_IDS = [
  "theme_d6_w1_database_storage_greenfield_implementation:target-round-5",
  "theme_d3_w9_testing_quality_reproducibility_verification:target-round-5",
] as const;

export interface T1IdentityGroup {
  causalGroupId: string;
  taskId: string;
  officialDomainId: "d6" | "d3";
  targetRound: 5;
  sourceMemoryRound: 4;
  statisticalClusterId: string;
  candidateHash: string;
  sourceEvidenceHash: string;
}

export interface T1ExactManifest {
  schemaVersion: "direction-a.evo-engineering-first-t1-exact-manifest.v2";
  decisionId: typeof T1_DECISION_ID;
  stage: "EVO_ENGINEERING_FIRST_T1";
  status: "FROZEN_PENDING_RESEARCHER_REAUTHORIZATION";
  exactTaskIds: string[];
  exactCausalGroupIds: string[];
  groups: T1IdentityGroup[];
  overlapProof: { q6: []; fresh13: []; t2: [] };
  protocol: {
    normalPerGroup: 1;
    fixedPairCount: 4;
    pair5Forbidden: true;
    technicalRetryLimitPerCompleteGroup: 2;
    scientificFailureIsValidObservation: true;
  };
  budget: { expectedProviderCalls: 216; maximumProviderCalls: 264; stageHardCapCny: 36.4; globalHardCapCny: 100 };
  contentHash: string;
}

export type T1PreparedGroup = Omit<Initial6PreparedGroupManifest, "selectionRole" | "deepReference" | "validPairMaximum" | "validPairMinimum"> & {
  selectionRole: "T1_FIXED";
  deepReference: false;
  validPairMaximum: 4;
  validPairMinimum: 4;
  candidateHash: string;
  sourceEvidenceHash: string;
  sourceMemoryRound: 4;
};

export interface T1PreparedExecutionManifest {
  schemaVersion: "direction-a.evo-engineering-first-t1-prepared-manifest.v2";
  decisionId: typeof T1_DECISION_ID;
  stage: "EVO_ENGINEERING_FIRST_T1";
  scopeManifestHash: string;
  executionProfileHash: string;
  groups: T1PreparedGroup[];
  preparedByDriverSha256: string;
  contentHash: string;
}

const EXPECTED_GROUPS: readonly T1IdentityGroup[] = [
  {
    causalGroupId: T1_GROUP_IDS[0], taskId: T1_TASK_IDS[0], officialDomainId: "d6", targetRound: 5,
    sourceMemoryRound: 4, statisticalClusterId: T1_TASK_IDS[0],
    candidateHash: "cba5186ee6434a899dfa383ba51f7008e7ff77bc9d7b968a7686fce0bae8bb0e",
    sourceEvidenceHash: "58bf9c76dbf0b5f212306a49643cf6cf8dae03a3bf0674d70c25c9a282d1a1ea",
  },
  {
    causalGroupId: T1_GROUP_IDS[1], taskId: T1_TASK_IDS[1], officialDomainId: "d3", targetRound: 5,
    sourceMemoryRound: 4, statisticalClusterId: T1_TASK_IDS[1],
    candidateHash: "fcaf5c9824f9c83fc9d0874d1b6da0d86971af9d7e436e336b742cd39bd963ba",
    sourceEvidenceHash: "94d4abab38a0b1e0b91b7b8816d7cb73222ded55946c5b78bc2b706a295b925c",
  },
] as const;

function sameOrdered(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

export function assertT1ExactManifest(value: T1ExactManifest): void {
  const { contentHash, ...body } = value;
  if (hashCanonical(body) !== contentHash) throw new Error("T1_MANIFEST_HASH_MISMATCH");
  if (value.schemaVersion !== "direction-a.evo-engineering-first-t1-exact-manifest.v2"
    || value.decisionId !== T1_DECISION_ID || value.stage !== "EVO_ENGINEERING_FIRST_T1") throw new Error("T1_MANIFEST_AUTHORITY_MISMATCH");
  if (!sameOrdered(value.exactTaskIds, T1_TASK_IDS) || !sameOrdered(value.exactCausalGroupIds, T1_GROUP_IDS)) throw new Error("T1_MANIFEST_EXACT_SCOPE_MISMATCH");
  if (value.groups.length !== 2 || hashCanonical(value.groups) !== hashCanonical(EXPECTED_GROUPS)) throw new Error("T1_MANIFEST_GROUP_IDENTITY_MISMATCH");
  if (value.overlapProof.q6.length || value.overlapProof.fresh13.length || value.overlapProof.t2.length) throw new Error("T1_MANIFEST_FORBIDDEN_OVERLAP");
  if (hashCanonical(value.protocol) !== hashCanonical({ normalPerGroup: 1, fixedPairCount: 4, pair5Forbidden: true,
    technicalRetryLimitPerCompleteGroup: 2, scientificFailureIsValidObservation: true })) throw new Error("T1_MANIFEST_PROTOCOL_MISMATCH");
  if (hashCanonical(value.budget) !== hashCanonical({ expectedProviderCalls: 216, maximumProviderCalls: 264,
    stageHardCapCny: 36.4, globalHardCapCny: 100 })) throw new Error("T1_MANIFEST_BUDGET_MISMATCH");
}

export function assertT1PreparedExecutionManifest(value: T1PreparedExecutionManifest, scope: T1ExactManifest): void {
  assertT1ExactManifest(scope);
  const { contentHash, ...body } = value;
  if (hashCanonical(body) !== contentHash || value.scopeManifestHash !== scope.contentHash) throw new Error("T1_PREPARED_MANIFEST_HASH_OR_SCOPE_MISMATCH");
  if (value.schemaVersion !== "direction-a.evo-engineering-first-t1-prepared-manifest.v2" || value.decisionId !== T1_DECISION_ID
    || value.stage !== "EVO_ENGINEERING_FIRST_T1" || !/^[a-f0-9]{64}$/.test(value.preparedByDriverSha256)
    || !/^[a-f0-9]{64}$/.test(value.executionProfileHash)) throw new Error("T1_PREPARED_MANIFEST_AUTHORITY_MISMATCH");
  if (value.groups.length !== 2 || !sameOrdered(value.groups.map((row) => row.causalGroupId), T1_GROUP_IDS)) throw new Error("T1_PREPARED_MANIFEST_GROUP_SCOPE_MISMATCH");
  for (const [index, group] of value.groups.entries()) {
    const identity = EXPECTED_GROUPS[index];
    if (group.taskId !== identity.taskId || group.statisticalClusterId !== identity.statisticalClusterId
      || group.officialDomainId !== identity.officialDomainId || group.targetRound !== 5 || group.sourceMemoryRound !== 4
      || group.candidateHash !== identity.candidateHash || group.sourceEvidenceHash !== identity.sourceEvidenceHash) throw new Error("T1_PREPARED_MANIFEST_IDENTITY_MISMATCH");
    assertPairSchedule(group.pairSchedule);
    if (group.selectionRole !== "T1_FIXED" || group.deepReference || group.validPairMinimum !== 4 || group.validPairMaximum !== 4
      || !sameOrdered(group.pairSchedule.rows.map((row) => row.pairIndex).sort((a, b) => a - b).map(String), ["1", "2", "3", "4"])
      || group.technicalRetryReserveTrials !== 2) throw new Error("T1_PREPARED_MANIFEST_FIXED4_MISMATCH");
    if (![group.normalTaskDirectoryHash, group.fullTaskDirectoryHash, group.removeTaskDirectoryHash, group.frozenPrefixHash,
      group.targetGroupHash, group.recallSnapshotHash, group.guideNormalizationHash, group.preparationArtifactHash]
      .every((entry) => typeof entry === "string" && entry.length > 0)) throw new Error("T1_PREPARED_MANIFEST_BINDING_MISSING");
  }
}

export function createT1ExactManifest(): T1ExactManifest {
  const body = {
    schemaVersion: "direction-a.evo-engineering-first-t1-exact-manifest.v2" as const,
    decisionId: T1_DECISION_ID, stage: "EVO_ENGINEERING_FIRST_T1" as const,
    status: "FROZEN_PENDING_RESEARCHER_REAUTHORIZATION" as const,
    exactTaskIds: [...T1_TASK_IDS], exactCausalGroupIds: [...T1_GROUP_IDS], groups: structuredClone(EXPECTED_GROUPS) as T1IdentityGroup[],
    overlapProof: { q6: [] as [], fresh13: [] as [], t2: [] as [] },
    protocol: { normalPerGroup: 1 as const, fixedPairCount: 4 as const, pair5Forbidden: true as const,
      technicalRetryLimitPerCompleteGroup: 2 as const, scientificFailureIsValidObservation: true as const },
    budget: { expectedProviderCalls: 216 as const, maximumProviderCalls: 264 as const, stageHardCapCny: 36.4 as const, globalHardCapCny: 100 as const },
  };
  return immutableCopy({ ...body, contentHash: hashCanonical(body) }) as T1ExactManifest;
}
