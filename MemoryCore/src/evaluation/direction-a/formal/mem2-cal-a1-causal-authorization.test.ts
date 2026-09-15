import {describe,expect,it} from "vitest";
import {approvalTokenFor,assertMem2CausalFrozenSampleBinding,assertMem2PaidAuthorizationRequest,bindMem2PaidAuthorizationRequest,
  materializeImmutableMem2PaidAuthorization,type Mem2PaidAuthorizationRequestBody}
  from "./acquisition/mem2-formal-stage-authorization.js";
import {buildA1ExtendedBudgetLedger} from "./acquisition/mem2-formal-budget.js";
import {hashCanonical} from "./core/canonical.js";

const h="a".repeat(64),commit="b".repeat(40);
const requestBody:Mem2PaidAuthorizationRequestBody={schemaVersion:"direction-a.mem2-v7.1.paid-authorization-request.v1",
  status:"RESEARCHER_AUTHORIZATION_REQUIRED",purpose:"MEM2_CAL_A1_CAUSAL_AUDIT",formalStageIdentity:"MEM2_CAL_A1_CAUSAL_AUDIT",
  candidateBranch:"codex/direction-a-mem2-dev-augmentation-v1",candidateCommit:commit,candidateTree:commit,
  candidateSnapshotHash:h,candidatePackageHash:h,sourceHashScope:"GIT_COMMITTED_BLOB_BYTES",sourceBindingManifestHash:h,
  authorityBindingHash:h,protocolHash:h,profileHash:h,verifierHash:h,
  researcherApprovalTextHashExpectedAfterApproval:"PENDING_RESEARCHER_APPROVAL",freshPopulationRegistryHash:h,
  formalExclusionRegistryHash:h,trainPartitionHash:h,devPartitionHash:h,protectedCalPartitionHash:h,
  protectedSealedTestPartitionHash:h,taskSourceManifestHash:h,formalAdapterSourceHash:h,runnerSourceHash:h,
  stageCliSourceHash:h,authorizationMaterializerSourceHash:h,finalPolicyFamilyHash:h,finalExecutionPolicyHashes:[h],
  paidSupportSourceHashes:{budget:h,journal:h,resume:h,reference:h},budgetLedgerPredecessorHash:h,
  budgetLedgerCurrentHash:h,priceRateManifestHash:h,budgetExpansionAuthorityHash:h,a1BudgetExtensionAmendmentSha256:h,
  a2ClosedStatusHash:h,predictionPopulationHash:h,activeTier:"MINIMUM_FEASIBLE",finalCalAnchor:"P70",
  finalCalSequence:["P70","P80"],formalCalAuditN:2,alphaPlanHashes:[h],sampleManifestHash:h,budgetForecastHash:h,
  noSampleRedraw:true,forbiddenStages:["SEALED_TEST","EVO","E_B"],maximumPairSlotsPerGroup:5,
  allowedStageGroups:["g1","g2"],maximumGroups:2,maximumNormalCalls:0,maximumFullRemoveCalls:20,
  maximumProviderCalls:20,maximumCostCny:1,planningReservationCny:1,
  costSemantics:"CONSERVATIVE_PLANNING_RESERVATION_NOT_EX_POST_PROVIDER_COST_GUARANTEE",hardCapCny:55,
  protectedObservedUsageCny:10,protectedUnknownBillingReserveCny:2,protectedDownstreamReserveCny:15,
  outputRoot:"out",journalRoot:"journal",rawArtifactRoot:"raw",provider:"deepseek",model:"deepseek-v4-pro",
  reasoningEffort:"low",maxOutputTokens:8192,timeoutMs:300000,sdkRetry:0,technicalRetry:0,toolsEnabled:false,
  normalContract:{independentPreYObservation:true,sameFrozenTargetMemoryAvailabilityAsFull:true,reusedAsFull:false,
    countsAsFullReplicate:false,countsAsCausalPairArm:false,containsCausalY:false},
  fixed4Contract:{validPairsRequired:4,maximumPredeclaredPairSlots:5,slot5Trigger:"TRUE_TECHNICAL_INVALIDITY_ONLY"},
  uncertainStartedCallRule:"HOLD_NO_REDELIVERY_WITHOUT_DURABLE_RECOVERY_OR_PROOF_NOT_DISPATCHED",formalUseForbidden:false,
  calCausalYExpected:0,sealedTestCausalYExpected:0,formalTrainDevPaidCallsExpectedBeforeApproval:0};

describe("Mem2 CAL A1 causal authorization",()=>{
  it("binds the frozen sample, alpha, n, budget and zero-NORMAL ceiling",()=>{
    const request=bindMem2PaidAuthorizationRequest(requestBody);assertMem2PaidAuthorizationRequest(request);
    expect(request.maximumNormalCalls).toBe(0);expect(request.maximumFullRemoveCalls).toBe(20);
    expect(approvalTokenFor(request)).toBe(`APPROVE_MEM2_CAL_A1_CAUSAL_AUDIT ${request.contentHash}`);
    const auth=materializeImmutableMem2PaidAuthorization({request,approvalText:approvalTokenFor(request),approvedBy:"researcher",
      approvedAt:"2026-09-11T00:00:00.000Z"});
    expect(auth.requestContentHash).toBe(request.contentHash);
  });
  it("fails closed on a sample/n/call-ceiling drift",()=>{
    expect(()=>bindMem2PaidAuthorizationRequest({...requestBody,maximumFullRemoveCalls:19})).toThrow("SCOPE_INVALID");
    expect(()=>bindMem2PaidAuthorizationRequest({...requestBody,formalCalAuditN:3})).toThrow("SCOPE_INVALID");
    expect(()=>bindMem2PaidAuthorizationRequest({...requestBody,sourceHashScope:undefined})).toThrow("SCOPE_INVALID");
  });
  it("fails closed on frozen sample hash or ID drift",()=>{
    const request=bindMem2PaidAuthorizationRequest(requestBody);
    const sample={contentHash:h,n:2,selectedComponentIds:["g1","g2"],noRedraw:true,status:"FROZEN_ONCE"};
    expect(()=>assertMem2CausalFrozenSampleBinding({request,sample:{...sample,contentHash:"c".repeat(64)}})).toThrow("SAMPLE_BINDING_DRIFT");
    expect(()=>assertMem2CausalFrozenSampleBinding({request,sample:{...sample,selectedComponentIds:["g1","changed"]}})).toThrow("SAMPLE_BINDING_DRIFT");
    expect(()=>assertMem2CausalFrozenSampleBinding({request,sample})).not.toThrow();
  });
  it("builds only the exact effective-cap successor ledger",()=>{
    const body={schemaVersion:"direction-a.mem2-source.global-budget.v4" as const,hardCapCny:53,
      budgetExpansionAuthorityHash:h,observedUsageAccountedCny:10,providerBillingUnknownReserveCny:2,
      downstreamFormalReserveFloorCny:15,activeReservations:[],completedReservations:[],predecessorStateHash:h,
      timeoutRepairAuthorityHash:h};
    const prior={...body,contentHash:hashCanonical(body)};
    const next=buildA1ExtendedBudgetLedger(prior,{effectiveHardCapCny:55,minimumRequiredHardCapCny:55,
      a1BudgetExtensionAmendmentSha256:h});
    expect(next.schemaVersion).toBe("direction-a.mem2-source.global-budget.v5");
    expect(next.predecessorStateHash).toBe(prior.contentHash);
    expect(()=>buildA1ExtendedBudgetLedger(prior,{effectiveHardCapCny:56,minimumRequiredHardCapCny:55,
      a1BudgetExtensionAmendmentSha256:h})).toThrow("LEDGER_INVALID");
  });
});
