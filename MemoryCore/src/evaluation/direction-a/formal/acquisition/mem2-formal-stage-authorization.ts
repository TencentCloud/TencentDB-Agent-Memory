import { hashCanonical, immutableCopy } from "../core/canonical.js";

export type Mem2PaidPurpose = "POST_ADAPTER_MINIMUM_SMOKE" | "MEM2_FORMAL_TRAIN_DEV"
  | "MEM2_CAL_CHEAP_X_AND_POLICY_FREEZE_ONLY" | "MEM2_DEV_SUPPORT_AUGMENTATION_V1"
  | "MEM2_CAL_A1_CAUSAL_AUDIT";

export type Mem2CandidateBranch = "direction-a/formal-train-dev-adapter-v1"
  | "direction-a/formal-train-dev-budget53-v1"
  | "direction-a/mem2-v71-precal-model-freeze-v1"
  | "codex/direction-a-mem2-dev-augmentation-v1";

export interface Mem2PaidAuthorizationRequestBody {
  schemaVersion: "direction-a.mem2-v7.1.paid-authorization-request.v1";
  status: "RESEARCHER_AUTHORIZATION_REQUIRED";
  purpose: Mem2PaidPurpose;
  formalStageIdentity: "MEM2_V7_1_POST_ADAPTER_SMOKE" | "MEM2_FORMAL_TRAIN_DEV"
    | "MEM2_CAL_CHEAP_X_AND_POLICY_FREEZE_ONLY" | "MEM2_DEV_SUPPORT_AUGMENTATION_V1"
    | "MEM2_CAL_A1_CAUSAL_AUDIT";
  candidateBranch: Mem2CandidateBranch;
  candidateCommit: string;
  candidateTree: string;
  candidateSnapshotHash: string;
  candidatePackageHash: string;
  sourceHashScope?: "GIT_COMMITTED_BLOB_BYTES";
  sourceBindingManifestHash?: string;
  baseFrozenDesignBindingHash?: string;
  preCalSequenceAmendmentSha256?: string;
  authorityBindingHash: string;
  protocolHash: string;
  profileHash: string;
  verifierHash: string;
  researcherApprovalTextHashExpectedAfterApproval: "PENDING_RESEARCHER_APPROVAL";
  freshPopulationRegistryHash: string;
  formalExclusionRegistryHash: string;
  trainPartitionHash: string;
  devPartitionHash: string;
  protectedCalPartitionHash: string;
  protectedSealedTestPartitionHash: string;
  taskSourceManifestHash: string;
  formalAdapterSourceHash: string;
  runnerSourceHash: string;
  stageCliSourceHash: string;
  authorizationMaterializerSourceHash?: string;
  finalPolicyFamilyHash?: string;
  finalExecutionPolicyHashes?: string[];
  paidSupportSourceHashes?: Record<string,string>;
  budgetLedgerPredecessorHash: string;
  priceRateManifestHash: string;
  budgetExpansionAuthorityHash?: string;
  a1BudgetExtensionAmendmentSha256?: string;
  a2ClosedStatusHash?: string;
  predictionPopulationHash?: string;
  activeTier?: "TRAINING_FIRST" | "MINIMUM_FEASIBLE";
  finalCalAnchor?: string;
  finalCalSequence?: string[];
  formalCalAuditN?: number;
  alphaPlanHashes?: string[];
  sampleManifestHash?: string;
  budgetForecastHash?: string;
  budgetLedgerCurrentHash?: string;
  noSampleRedraw?: true;
  forbiddenStages?: Array<"SEALED_TEST"|"EVO"|"E_B">;
  maximumPairSlotsPerGroup?: 5;
  allowedStageGroups: string[];
  maximumGroups: number;
  maximumNormalCalls: number;
  maximumFullRemoveCalls: number;
  maximumProviderCalls: number;
  maximumCostCny: number;
  planningReservationCny?: number;
  costSemantics?: "CONSERVATIVE_PLANNING_RESERVATION_NOT_EX_POST_PROVIDER_COST_GUARANTEE";
  hardCapCny: number;
  protectedObservedUsageCny: number;
  protectedUnknownBillingReserveCny: number;
  protectedDownstreamReserveCny: number;
  outputRoot: string;
  journalRoot: string;
  rawArtifactRoot: string;
  provider: "deepseek";
  model: "deepseek-v4-pro";
  reasoningEffort: "low";
  maxOutputTokens: 8192;
  timeoutMs: 300000;
  sdkRetry: 0;
  technicalRetry: 0;
  toolsEnabled: false;
  normalContract: {
    independentPreYObservation: true;
    sameFrozenTargetMemoryAvailabilityAsFull: true;
    reusedAsFull: false;
    countsAsFullReplicate: false;
    countsAsCausalPairArm: false;
    containsCausalY: false;
  };
  fixed4Contract: { validPairsRequired: 4; maximumPredeclaredPairSlots: 5; slot5Trigger: "TRUE_TECHNICAL_INVALIDITY_ONLY" };
  uncertainStartedCallRule: "HOLD_NO_REDELIVERY_WITHOUT_DURABLE_RECOVERY_OR_PROOF_NOT_DISPATCHED";
  formalUseForbidden: boolean;
  calCausalYExpected: 0;
  sealedTestCausalYExpected: 0;
  formalTrainDevPaidCallsExpectedBeforeApproval: 0 | 162;
}

export interface Mem2PaidAuthorizationRequest extends Mem2PaidAuthorizationRequestBody { contentHash: string }

export interface ImmutableMem2PaidAuthorizationBody {
  schemaVersion: "direction-a.mem2-v7.1.immutable-paid-authorization.v1";
  status: "IMMUTABLE_APPROVED";
  purpose: Mem2PaidPurpose;
  requestContentHash: string;
  requestSnapshotHash: string;
  requestCommit: string;
  requestTree: string;
  requestBranch: Mem2CandidateBranch;
  approvedBy: string;
  approvedAt: string;
  approvalText: string;
  approvalTextHash: string;
}

export interface ImmutableMem2PaidAuthorization extends ImmutableMem2PaidAuthorizationBody { contentHash: string }

const sha = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);

export function approvalTokenFor(request: Mem2PaidAuthorizationRequest): string {
  return request.purpose === "MEM2_CAL_A1_CAUSAL_AUDIT"
    ? `APPROVE_MEM2_CAL_A1_CAUSAL_AUDIT ${request.contentHash}`
    : request.purpose === "POST_ADAPTER_MINIMUM_SMOKE"
    ? `APPROVE_POST_ADAPTER_SMOKE ${request.contentHash}`
    : request.purpose === "MEM2_FORMAL_TRAIN_DEV"
      ? `APPROVE_FORMAL_TRAIN_DEV ${request.contentHash}`
      : request.purpose === "MEM2_DEV_SUPPORT_AUGMENTATION_V1"
        ? `APPROVE_MEM2_DEV_SUPPORT_AUGMENTATION_V1 ${request.contentHash}`
        : `APPROVE_MEM2_CAL_CHEAP_X_POLICY_FREEZE ${request.contentHash}`;
}

export function bindMem2PaidAuthorizationRequest(body: Mem2PaidAuthorizationRequestBody): Mem2PaidAuthorizationRequest {
  const request = immutableCopy({ ...body, contentHash: hashCanonical(body) });
  assertMem2PaidAuthorizationRequest(request);
  return request;
}

export function assertMem2CausalFrozenSampleBinding(input: {
  request: Pick<Mem2PaidAuthorizationRequest, "sampleManifestHash" | "formalCalAuditN" | "allowedStageGroups" | "noSampleRedraw">;
  sample: { contentHash: string; n: number; selectedComponentIds: string[]; noRedraw?: boolean; status?: string };
}): void {
  const { request, sample } = input;
  if (sample.contentHash !== request.sampleManifestHash || sample.n !== request.formalCalAuditN
    || hashCanonical(sample.selectedComponentIds) !== hashCanonical(request.allowedStageGroups)
    || new Set(sample.selectedComponentIds).size !== sample.selectedComponentIds.length
    || request.noSampleRedraw !== true || sample.noRedraw !== true || sample.status !== "FROZEN_ONCE") {
    throw new Error("MEM2_CAL_A1_FROZEN_SAMPLE_BINDING_DRIFT");
  }
}

export function assertMem2PaidAuthorizationRequest(request: Mem2PaidAuthorizationRequest): void {
  const { contentHash, ...body } = request;
  const hashFields = [request.candidateSnapshotHash, request.candidatePackageHash,
    ...(request.sourceBindingManifestHash === undefined ? [] : [request.sourceBindingManifestHash]),
    ...(request.baseFrozenDesignBindingHash === undefined ? [] : [request.baseFrozenDesignBindingHash]),
    ...(request.preCalSequenceAmendmentSha256 === undefined ? [] : [request.preCalSequenceAmendmentSha256]),
    request.authorityBindingHash, request.protocolHash, request.profileHash, request.verifierHash,
    request.freshPopulationRegistryHash, request.formalExclusionRegistryHash, request.trainPartitionHash, request.devPartitionHash,
    request.protectedCalPartitionHash, request.protectedSealedTestPartitionHash, request.taskSourceManifestHash,
    request.formalAdapterSourceHash, request.runnerSourceHash, request.stageCliSourceHash,
    ...(request.authorizationMaterializerSourceHash === undefined ? [] : [request.authorizationMaterializerSourceHash]),
    ...(request.finalPolicyFamilyHash === undefined ? [] : [request.finalPolicyFamilyHash]),
    ...(request.finalExecutionPolicyHashes ?? []),
    ...Object.values(request.paidSupportSourceHashes ?? {}),
    request.budgetLedgerPredecessorHash, request.priceRateManifestHash,
    ...(request.budgetExpansionAuthorityHash === undefined ? [] : [request.budgetExpansionAuthorityHash]),
    ...(request.a1BudgetExtensionAmendmentSha256===undefined?[]:[request.a1BudgetExtensionAmendmentSha256]),
    ...(request.a2ClosedStatusHash===undefined?[]:[request.a2ClosedStatusHash]),
    ...(request.predictionPopulationHash===undefined?[]:[request.predictionPopulationHash]),
    ...(request.alphaPlanHashes??[]),...(request.sampleManifestHash===undefined?[]:[request.sampleManifestHash]),
    ...(request.budgetForecastHash===undefined?[]:[request.budgetForecastHash]),
    ...(request.budgetLedgerCurrentHash===undefined?[]:[request.budgetLedgerCurrentHash])];
  if (hashCanonical(body) !== contentHash || !sha(contentHash) || !/^[a-f0-9]{40}$/.test(request.candidateCommit)
    || !/^[a-f0-9]{40}$/.test(request.candidateTree) || hashFields.some((value) => !sha(value))) {
    throw new Error("MEM2_PAID_AUTHORIZATION_REQUEST_HASH_MISMATCH");
  }
  const smoke = request.purpose === "POST_ADAPTER_MINIMUM_SMOKE";
  const trainDev = request.purpose === "MEM2_FORMAL_TRAIN_DEV";
  const cheapX = request.purpose === "MEM2_CAL_CHEAP_X_AND_POLICY_FREEZE_ONLY";
  const augmentation = request.purpose === "MEM2_DEV_SUPPORT_AUGMENTATION_V1";
  const causal = request.purpose === "MEM2_CAL_A1_CAUSAL_AUDIT";
  const legacyBudget = request.hardCapCny === 30
    && request.candidateBranch === "direction-a/formal-train-dev-adapter-v1"
    && request.budgetExpansionAuthorityHash === undefined;
  const expandedBudget = request.hardCapCny === 53
    && ((trainDev && request.candidateBranch === "direction-a/formal-train-dev-budget53-v1")
      || (cheapX && ["direction-a/mem2-v71-precal-model-freeze-v1","codex/direction-a-mem2-dev-augmentation-v1"].includes(request.candidateBranch))
      || (augmentation && request.candidateBranch === "codex/direction-a-mem2-dev-augmentation-v1"))
    && /^[a-f0-9]{64}$/.test(request.budgetExpansionAuthorityHash ?? "");
  const a1ExtendedBudget=causal&&request.hardCapCny>=53&&request.hardCapCny<=68
    &&sha(request.a1BudgetExtensionAmendmentSha256??"")&&sha(request.budgetExpansionAuthorityHash??"");
  const expectedStage = smoke ? "MEM2_V7_1_POST_ADAPTER_SMOKE"
    : trainDev ? "MEM2_FORMAL_TRAIN_DEV"
      : augmentation ? "MEM2_DEV_SUPPORT_AUGMENTATION_V1"
        : causal ? "MEM2_CAL_A1_CAUSAL_AUDIT" : "MEM2_CAL_CHEAP_X_AND_POLICY_FREEZE_ONLY";
  const expectedFullRemoveCalls = cheapX ? 0 : request.maximumGroups * 10;
  if (request.status !== "RESEARCHER_AUTHORIZATION_REQUIRED"
    || request.formalStageIdentity !== expectedStage
    || request.provider !== "deepseek" || request.model !== "deepseek-v4-pro" || request.reasoningEffort !== "low"
    || request.maxOutputTokens !== 8192 || request.timeoutMs !== 300000 || request.sdkRetry !== 0
    || request.technicalRetry !== 0 || request.toolsEnabled !== false || (!legacyBudget && !expandedBudget&&!a1ExtendedBudget)
    || request.calCausalYExpected !== 0 || request.sealedTestCausalYExpected !== 0
    || request.formalTrainDevPaidCallsExpectedBeforeApproval !== (cheapX || augmentation ? 162 : 0) || request.maximumGroups < 1
    || request.allowedStageGroups.length !== request.maximumGroups || new Set(request.allowedStageGroups).size !== request.maximumGroups
    || request.maximumNormalCalls !== (causal?0:request.maximumGroups)
    || request.maximumFullRemoveCalls !== expectedFullRemoveCalls
    || request.maximumProviderCalls !== request.maximumNormalCalls + request.maximumFullRemoveCalls
    || !(request.maximumCostCny > 0)
    || (cheapX && (request.planningReservationCny !== request.maximumCostCny
      || request.costSemantics !== "CONSERVATIVE_PLANNING_RESERVATION_NOT_EX_POST_PROVIDER_COST_GUARANTEE"
      || request.finalPolicyFamilyHash === undefined || !(request.finalExecutionPolicyHashes?.length)
      || !request.paidSupportSourceHashes || Object.keys(request.paidSupportSourceHashes).length<4
      || request.baseFrozenDesignBindingHash === undefined || request.preCalSequenceAmendmentSha256 === undefined))
    || (causal&&(!request.predictionPopulationHash||!request.a2ClosedStatusHash||!request.finalPolicyFamilyHash
      ||request.sourceHashScope!=="GIT_COMMITTED_BLOB_BYTES"||!request.sourceBindingManifestHash
      ||!request.activeTier||!request.finalCalAnchor||!request.finalCalSequence?.length
      ||request.formalCalAuditN!==request.maximumGroups||!request.alphaPlanHashes?.length
      ||!request.sampleManifestHash||!request.budgetForecastHash||!request.budgetLedgerCurrentHash
      ||request.allowedStageGroups.length!==request.formalCalAuditN||request.maximumPairSlotsPerGroup!==5
      ||request.maximumFullRemoveCalls!==10*request.formalCalAuditN||request.maximumProviderCalls!==10*request.formalCalAuditN
      ||request.noSampleRedraw!==true||hashCanonical(request.forbiddenStages)!==hashCanonical(["SEALED_TEST","EVO","E_B"])))
    || request.protectedObservedUsageCny + request.protectedUnknownBillingReserveCny
      + request.protectedDownstreamReserveCny + request.maximumCostCny > request.hardCapCny + 1e-12
    || !request.outputRoot || !request.journalRoot || !request.rawArtifactRoot
    || !request.normalContract.independentPreYObservation || !request.normalContract.sameFrozenTargetMemoryAvailabilityAsFull
    || request.normalContract.reusedAsFull || request.normalContract.countsAsFullReplicate
    || request.normalContract.countsAsCausalPairArm || request.normalContract.containsCausalY
    || request.fixed4Contract.validPairsRequired !== 4 || request.fixed4Contract.maximumPredeclaredPairSlots !== 5
    || request.fixed4Contract.slot5Trigger !== "TRUE_TECHNICAL_INVALIDITY_ONLY"
    || request.uncertainStartedCallRule !== "HOLD_NO_REDELIVERY_WITHOUT_DURABLE_RECOVERY_OR_PROOF_NOT_DISPATCHED"
    || request.formalUseForbidden !== smoke) throw new Error("MEM2_PAID_AUTHORIZATION_REQUEST_SCOPE_INVALID");
}

export function materializeImmutableMem2PaidAuthorization(input: {
  request: Mem2PaidAuthorizationRequest;
  approvalText: string;
  approvedBy: string;
  approvedAt: string;
}): ImmutableMem2PaidAuthorization {
  assertMem2PaidAuthorizationRequest(input.request);
  const expected = approvalTokenFor(input.request);
  if (input.approvalText.trim() !== expected || !input.approvedBy.trim() || Number.isNaN(Date.parse(input.approvedAt))) {
    throw new Error("RESEARCHER_AUTHORIZATION_TEXT_OR_IDENTITY_MISMATCH");
  }
  const body: ImmutableMem2PaidAuthorizationBody = {
    schemaVersion: "direction-a.mem2-v7.1.immutable-paid-authorization.v1",
    status: "IMMUTABLE_APPROVED",
    purpose: input.request.purpose,
    requestContentHash: input.request.contentHash,
    requestSnapshotHash: input.request.candidateSnapshotHash,
    requestCommit: input.request.candidateCommit,
    requestTree: input.request.candidateTree,
    requestBranch: input.request.candidateBranch,
    approvedBy: input.approvedBy.trim(),
    approvedAt: new Date(input.approvedAt).toISOString(),
    approvalText: expected,
    approvalTextHash: hashCanonical(expected),
  };
  return immutableCopy({ ...body, contentHash: hashCanonical(body) });
}

export function assertImmutableMem2PaidAuthorization(authorization: ImmutableMem2PaidAuthorization,
  request: Mem2PaidAuthorizationRequest): void {
  assertMem2PaidAuthorizationRequest(request);
  const { contentHash, ...body } = authorization;
  if (hashCanonical(body) !== contentHash || authorization.status !== "IMMUTABLE_APPROVED"
    || authorization.purpose !== request.purpose || authorization.requestContentHash !== request.contentHash
    || authorization.requestSnapshotHash !== request.candidateSnapshotHash || authorization.requestCommit !== request.candidateCommit
    || authorization.requestTree !== request.candidateTree || authorization.requestBranch !== request.candidateBranch
    || authorization.approvalText !== approvalTokenFor(request)
    || authorization.approvalTextHash !== hashCanonical(authorization.approvalText)
    || !authorization.approvedBy || Number.isNaN(Date.parse(authorization.approvedAt))) {
    throw new Error("RESEARCHER_AUTHORIZATION_REQUIRED_OR_BINDING_MISMATCH");
  }
}
