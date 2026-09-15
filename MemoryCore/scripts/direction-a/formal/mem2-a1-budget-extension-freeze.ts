import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPredictionPopulation, drawCalA1AuditSample, freezeAlphaPlan }
  from "../../../src/evaluation/direction-a/formal/analysis/mem2-a1.js";
import { hashCanonical, sha256 } from "../../../src/evaluation/direction-a/formal/core/canonical.js";
import { devPlanningWorlds, minimumFeasibleProbability, planMem2ScaleV2, trainingProbability, type PlannerInput }
  from "../../../src/evaluation/direction-a/formal/planning/mem2-scale-planner-v2.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../..");
const external=path.resolve(root,"../..");
const output=path.join(root,".research/direction-a/current-formal/mem2-a1-budget-extension-v1");
const runtime=path.join(external,"Direction_A_Mem2_CAL_CheapX_Run_v1/runtime/cal-cheap-x-policy-freeze");
const precalPackage=path.join(external,"Direction_A_Mem2_PreCAL_Policy_Freeze_v2");
const precal=path.join(precalPackage,"artifacts/mem2-precal-model-freeze-v2");
const inputs=path.join(precalPackage,"inputs/Direction_A_Formal_TrainDev_Complete_v1");
const currentPost=path.join(root,".research/direction-a/current-formal/mem2-postcalx-scale-planner-v1");
const a2Package=path.join(external,"Direction_A_Mem2_A2_ZeroAPI_Qualification_v1/qualification");
const authority=path.join(root,".research/direction-a/sources/codex_implementation_sync_package_v2/01_CURRENT_AUTHORITY");
const amendmentPath=path.join(authority,"MEM2_A1_BUDGET_EXTENSION_20260911.md");
const read=async<T=any>(file:string):Promise<T>=>JSON.parse(await readFile(file,"utf8")) as T;
const verify=(value:any,label:string)=>{const {contentHash,...body}=value;
  if(typeof contentHash!=="string"||hashCanonical(body)!==contentHash)throw new Error(`${label}_CONTENT_HASH_MISMATCH`);return value;};
const bounded=<T extends Record<string,unknown>>(body:T):T&{contentHash:string}=>({...body,contentHash:hashCanonical(body)});
const writeBound=async(file:string,value:Record<string,unknown>)=>writeFile(path.join(output,file),`${JSON.stringify(value,null,2)}\n`,{flag:"wx"});

const cheap=verify(await read(path.join(runtime,"CAL_CHEAP_X_FREEZE.json")),"CAL_CHEAP_X_FREEZE");
const floors=verify(await read(path.join(runtime,"CAL_FINAL_POLICY_OPERATIONAL_FLOORS.json")),"CAL_OPERATIONAL_FLOORS");
const population=verify(await read(path.join(runtime,"CAL_COMPLETE_PREDICTION_POPULATION.json")),"CAL_POPULATION");
const development=verify(await read(path.join(precal,"09_DEVELOPMENT_CANDIDATE_LADDER.json")),"DEVELOPMENT_LADDER");
const finalLadder=verify(await read(path.join(precal,"11_FINAL_CANDIDATE_LADDER.json")),"FINAL_LADDER");
const protectedCal=verify(await read(path.join(precal,"14_PROTECTED_CAL_POPULATION_MANIFEST.json")),"PROTECTED_CAL");
const partitions=verify(await read(path.join(inputs,"candidate/configs/UPDATED_DEV12_PARTITIONS.json")),"PARTITIONS");
const exclusions=verify(await read(path.join(inputs,"candidate/configs/FORMAL_EXCLUSION_REGISTRY.json")),"EXCLUSIONS");
const liveLedger=verify(await read(path.join(inputs,"LIVE_MEM2_BUDGET_LEDGER.json")),"LIVE_LEDGER");
const price=verify(await read(path.join(inputs,"candidate/configs/PRICE_RATE_MANIFEST.json")),"PRICE_RATE");
const costEvidence=verify(await read(path.join(root,".research/direction-a/current-formal/mem2-v7-1-continuous-reference-sync-v1/CONTINUOUS_SCALE_PLANNER_REPORT.json")),"COST_EVIDENCE");
const oldRecon=verify(await read(path.join(currentPost,"POSTCALX_INPUT_RECONCILIATION.json")),"OLD_RECONCILIATION");
const oldPlanner=verify(await read(path.join(currentPost,"A1_SCALE_PLANNER_POSTCALX.json")),"OLD_PLANNER");
const oldManifest=verify(await read(path.join(currentPost,"POSTCALX_PLANNER_FREEZE_MANIFEST.json")),"OLD_MANIFEST");
const a2=verify(await read(path.join(a2Package,"A2_QUALIFICATION_MANIFEST.json")),"A2_MANIFEST");
assertPredictionPopulation(population);

const expectedPopulationHash="b31e8e73a031f5cc6b1c7ee6d4c7db467e79af564fc72bfb63003e18bdcb8c99";
const expectedPartitionHash="bccc5477372f522c071a813998c57fdea6f0daf1f8979ec5e2075ff93ad48694";
const populationIds=population.rows.map((row:any)=>row.componentId).sort();
const purchased=cheap.rows.map((row:any)=>row.componentId).sort();
const completed=liveLedger.completedReservations.filter((row:any)=>row.reservationId==="mem2-formal-5a6d07a85b2dd4caabe2");
if(population.contentHash!==expectedPopulationHash||protectedCal.protectedCalPartitionHash!==expectedPartitionHash
  ||partitions.partitionHashes.PROTECTED_CAL!==expectedPartitionHash||hashCanonical(purchased)!==hashCanonical(populationIds)
  ||cheap.rows.length!==105||cheap.providerCalls!==105||cheap.fullRemoveCalls!==0||cheap.causalSampleDraw!==false
  ||cheap.calCausalY!==0||cheap.sealedTestCausalY!==0||floors.calCausalY!==0||floors.srsworDrawOccurred!==false
  ||liveLedger.contentHash!==oldRecon.sourceHashes.liveLedger||liveLedger.hardCapCny!==53
  ||liveLedger.downstreamFormalReserveFloorCny!==15||liveLedger.activeReservations.length!==0||completed.length!==1
  ||completed[0].paidLogicalCalls!==105||completed[0].unknownUsageCalls!==0
  ||a2.theoremMapping!=="FAIL"||a2.exactA2MethodId!=="NONE__HEDGED_WOR_FIXED4_MAPPING_REJECTED_V1")
  throw new Error("A1_EXTENSION_INPUT_INTEGRITY_STOP");

const developmentPolicies=development.preCalPolicyFamily.policies.map((row:any)=>({policyId:row.policy.policyId,
  targetCoverage:row.policy.targetCoverage,admission:row.admission,developmentAdmissionPolicyHash:row.developmentAdmissionPolicyHash,
  developmentPolicyHash:row.policy.policyHash}));
const finalPolicyProvenance=finalLadder.candidateRecords.filter((row:any)=>row.finalFrozenPolicy&&row.finalExecutionPolicyHash).map((row:any)=>({
  policyId:row.finalFrozenPolicy.policyId,targetCoverage:row.finalFrozenPolicy.targetCoverage,
  developmentAdmissionPolicyHash:row.developmentAdmissionPolicyHash,finalExecutionPolicyHash:row.finalExecutionPolicyHash,
  finalPolicyHash:row.finalFrozenPolicy.policyHash}));
const operationalFloors=floors.policies.map((row:any)=>({policyId:row.policyId,targetCoverage:row.targetCoverage,
  finalExecutionPolicyHash:row.finalExecutionPolicyHash,actualCalCoverage:row.actualCalCoverage,acceptedCount:row.acceptedCount,
  operationalEligibility:row.operationalEligibility}));
const first4:number[]=costEvidence.empiricalInputs.first4GroupCosts;
const sorted=[...first4].sort((a,b)=>a-b),p95=sorted[Math.ceil(.95*sorted.length)-1];
const baseBudget={ledgerHash:liveLedger.contentHash,registryHash:protectedCal.contentHash,
  reservationAuthorityHash:completed[0].authorizationHash,alreadyPaid:liveLedger.observedUsageAccountedCny,
  protectedExposure:liveLedger.providerBillingUnknownReserveCny,smokeReserve:0,technicalReserve:0,
  downstreamReservedCost:15,activeDownstreamReserveFloor:15,normalExpected:0,normalP95:0,
  fixed4Expected:costEvidence.empiricalInputs.costPerQualifiedClusterCny,max5P95:p95*10/8,
  normalAlreadyPurchasedIds:populationIds,freshComponentIds:populationIds,hardCapCny:53 as const};
const common={population,dev:development.devEvidence,trainDevFreezeHash:development.contentHash,
  finalPolicyFreezeHash:finalLadder.contentHash,operationalFloorReportHash:floors.contentHash,
  auditDrawOccurred:false as const,targetCausalYRevealed:false as const,developmentPolicies,finalPolicyProvenance,
  operationalFloors,floors:{minimumCoverage:floors.minimumCoverage,minimumAcceptedSupport:floors.minimumAcceptedSupport}};
const baseline=planMem2ScaleV2({...common,budget:baseBudget} as PlannerInput) as any;
const extendedBudget={...baseBudget,authorizedExtensionMaxCny:15 as const,maxExtendedHardCapCny:68 as const};
const planner=planMem2ScaleV2({...common,budget:extendedBudget} as PlannerInput) as any;
if(baseline.ACTIVE_TIER!=="NONE"||oldPlanner.planner.ACTIVE_TIER!=="NONE"||planner.ACTIVE_TIER==="NONE"
  ||planner.FORMAL_NUMERIC_N===null||planner.FINAL_CAL_SEQUENCE.length<1)throw new Error("A1_EXTENSION_TIER_SELECTION_STOP");
const eligible=planner.eligibility.filter((row:any)=>row.status==="ELIGIBLE");
if(eligible.map((row:any)=>row.targetCoverage).join(",")!=="30,40,50,60,70,80")throw new Error("A1_EXTENSION_ELIGIBILITY_DRIFT");
const selectedCost=planner.costs.find((row:any)=>row.audit_n===planner.FORMAL_NUMERIC_N);
if(!selectedCost?.legal||selectedCost.requiredExtensionCny>15+1e-12||selectedCost.effectiveHardCapCny>68+1e-12
  ||selectedCost.downstream_reserved_cost!==15||selectedCost.new_incremental_NORMAL_cheapX_count!==0)
  throw new Error("A1_EXTENSION_BUDGET_LEGALITY_STOP");
const smallerStatistical=planner.rows.some((row:any)=>{
  const required=planner.ACTIVE_TIER==="TRAINING_FIRST"?row.requiredN:row.minimumRequiredN;
  return required!==null&&required<planner.FORMAL_NUMERIC_N;});
if(smallerStatistical)throw new Error("A1_EXTENSION_ANCHOR_NOT_MINIMUM_N");

const alphaPlans=planner.FINAL_CAL_SEQUENCE.flatMap((policyId:string)=>(["V","G"] as const)
  .map(metric=>freezeAlphaPlan(population,policyId,metric,planner.FORMAL_NUMERIC_N)));
const amendmentSha256=sha256(await readFile(amendmentPath));
const inputReconciliation=bounded({schemaVersion:"MEM2_A1_BUDGET_EXTENSION_INPUT_RECONCILIATION.v1",status:"PASS",
  sourceHashes:{cheapX:cheap.contentHash,operationalFloors:floors.contentHash,predictionPopulation:population.contentHash,
    developmentLadder:development.contentHash,finalLadder:finalLadder.contentHash,protectedCal:protectedCal.contentHash,
    partitions:partitions.contentHash,exclusions:exclusions.contentHash,liveLedger:liveLedger.contentHash,costEvidence:costEvidence.contentHash,
    priceRateManifest:price.contentHash,postCalXManifest:oldManifest.contentHash,a2Qualification:a2.contentHash,budgetAmendmentSha256:amendmentSha256},
  counts:{normalAlreadyPurchased:105,newIncrementalNormalCheapX:0,calPopulation:105,full:0,remove:0},
  liveLedger:{observedUsageAccountedCny:liveLedger.observedUsageAccountedCny,
    providerBillingUnknownReserveCny:liveLedger.providerBillingUnknownReserveCny,downstreamReserveCny:15,activeReservations:0,
    predecessorStateHash:liveLedger.predecessorStateHash},providerCalls:0,secretReads:0,calCausalY:0,testCausalY:0,srsworDraws:0});
const a2Closed=bounded({schemaVersion:"MEM2_A2_FORMAL_CLOSED_STATUS.v1",status:"CLOSED_THEOREM_MAPPING_FAIL",method:"NONE",
  triggerHistory:"LEGALLY_OPENED_THEN_QUALIFICATION_FAILED",reactivation:"REQUIRES_NEW_EXPLICIT_RESEARCHER_DECISION",
  qualificationManifestHash:a2.contentHash,doNotReopen:true});
const replan=bounded({schemaVersion:"MEM2_A1_BUDGET_EXTENSION_REPLAN.v1",status:"FROZEN",baseHardCapCny:53,
  authorizedExtensionMaxCny:15,maxExtendedHardCapCny:68,downstreamReserveCny:15,baselineActiveTier:baseline.ACTIVE_TIER,
  planner,selectedCost,A2_STATUS:a2Closed.status});
const sequence=bounded({schemaVersion:"MEM2_A1_ACTIVE_TIER_AND_FINAL_CAL_SEQUENCE.v1",status:"FROZEN",
  ACTIVE_TIER:planner.ACTIVE_TIER,TRAINING_FIRST_ASSURANCE:planner.TRAINING_FIRST_ASSURANCE,CLAIM_DOWNGRADE:planner.CLAIM_DOWNGRADE,
  FINAL_CAL_ANCHOR:planner.FINAL_CAL_ANCHOR,FINAL_CAL_SEQUENCE:planner.FINAL_CAL_SEQUENCE,
  FORMAL_CAL_AUDIT_N:planner.FORMAL_NUMERIC_N,tieBreak:planner.tieBreak,finalSequenceHash:planner.finalSequenceHash});
const alpha=bounded({schemaVersion:"MEM2_A1_CAL_PRE_DRAW_ALPHA_PLANS.v1",status:"FROZEN_PRE_DRAW",plans:alphaPlans,
  alphaPlanHashes:alphaPlans.map((row:any)=>row.contentHash),sampleDrawn:false,selectedIdsIncluded:false,causalYIncluded:false});
const budget=bounded({schemaVersion:"MEM2_A1_CAL_CAUSAL_AUDIT_BUDGET_FORECAST.v1",status:"FROZEN_PRE_DRAW",
  ledgerHash:liveLedger.contentHash,costEvidenceHash:costEvidence.contentHash,priceRateManifestHash:price.contentHash,
  n:planner.FORMAL_NUMERIC_N,expectedCausalCalls:8*planner.FORMAL_NUMERIC_N,maximumFullRemoveCalls:10*planner.FORMAL_NUMERIC_N,
  conservativeCausalAuditCostCny:selectedCost.conservative_cost,expectedCausalAuditCostCny:selectedCost.expected_cost,
  observedSpendCny:selectedCost.already_paid,unknownReserveCny:selectedCost.protected_exposure,downstreamReserveCny:15,
  protectedTotalCny:selectedCost.minimumRequiredHardCapCny,requiredExtensionCny:selectedCost.requiredExtensionCny,
  effectiveHardCapCny:selectedCost.effectiveHardCapCny,maxExtendedHardCapCny:68,
  remainingHeadroomCny:68-selectedCost.minimumRequiredHardCapCny,newIncrementalNormalCheapX:0});

const selectedRow=planner.rows.find((row:any)=>row.policyId===planner.FINAL_CAL_ANCHOR);
if(!selectedRow)throw new Error("A1_EXTENSION_SELECTED_ROW_MISSING");
const selectedPolicy=population.policies.find((row:any)=>row.policyId===planner.FINAL_CAL_ANCHOR);
const selectedWorlds=devPlanningWorlds(development.devEvidence,planner.FINAL_CAL_ANCHOR);
const independentMinimum=minimumFeasibleProbability(population,planner.FINAL_CAL_ANCHOR,planner.FORMAL_NUMERIC_N,.95);
const independentMinimumPrevious=planner.FORMAL_NUMERIC_N>1
  ?minimumFeasibleProbability(population,planner.FINAL_CAL_ANCHOR,planner.FORMAL_NUMERIC_N-1,.95):null;
const independentTraining=planner.ACTIVE_TIER==="TRAINING_FIRST"?selectedWorlds.map(world=>trainingProbability(population,
  planner.FINAL_CAL_ANCHOR,planner.FORMAL_NUMERIC_N,.95,world,
  eligible.length*planner.costs.filter((row:any)=>row.legal).length*selectedWorlds.length*3)):[];
const independentTrainingPrevious=planner.ACTIVE_TIER==="TRAINING_FIRST"&&planner.FORMAL_NUMERIC_N>1
  ?selectedWorlds.map(world=>trainingProbability(population,planner.FINAL_CAL_ANCHOR,planner.FORMAL_NUMERIC_N-1,.95,world,
    eligible.length*planner.costs.filter((row:any)=>row.legal).length*selectedWorlds.length*3)):[];
const secondPass={selectedPolicyHash:selectedPolicy?.policyHash,minimum:independentMinimum,
  minimumPrevious:independentMinimumPrevious,training:independentTraining,trainingPrevious:independentTrainingPrevious,
  selectedCost,sequence:planner.FINAL_CAL_SEQUENCE,anchor:planner.FINAL_CAL_ANCHOR,n:planner.FORMAL_NUMERIC_N};
const plannerMinimum=selectedRow.minimum.find((row:any)=>row.n===planner.FORMAL_NUMERIC_N)?.primary;
const mechanicalRecomputeMatches=hashCanonical(plannerMinimum)===hashCanonical(independentMinimum);
const baselinePrefixStable=baseline.rows.every((row:any)=>{const newer=planner.rows.find((q:any)=>q.policyId===row.policyId);
  return row.minimum.every((q:any)=>hashCanonical(q)===hashCanonical(newer.minimum.find((x:any)=>x.n===q.n)));});
const checks={authoritativeLedgerUniqueLatestSuccessor:liveLedger.contentHash===oldRecon.sourceHashes.liveLedger&&liveLedger.activeReservations.length===0,
  normal105PurchasedAndZeroIncremental:purchased.length===105&&selectedCost.new_incremental_NORMAL_cheapX_count===0,
  a2Closed:a2Closed.doNotReopen,A1MechanicalRecompute:mechanicalRecomputeMatches,
  affordabilityOnlyStatisticalPrefixUnchanged:baselinePrefixStable,cny53Priority:baseline.ACTIVE_TIER==="NONE",
  minimumNecessaryExtension:selectedCost.effectiveHardCapCny===53+selectedCost.requiredExtensionCny,
  capAtMost68:selectedCost.effectiveHardCapCny<=68,downstreamReservePreserved:selectedCost.downstream_reserved_cost===15,
  anchorSequenceFormalNFrozen:sequence.FORMAL_CAL_AUDIT_N===planner.FORMAL_NUMERIC_N,
  selectedMinimumRecomputed:independentMinimum.status==="FEASIBLE",
  selectedTrainingRecomputed:planner.ACTIVE_TIER!=="TRAINING_FIRST"||independentTraining.every(row=>row.status==="FEASIBLE"),
  selectedNMinimalRecomputed:planner.ACTIVE_TIER==="TRAINING_FIRST"
    ?independentTrainingPrevious.some(row=>row.status!=="FEASIBLE")
    :independentMinimumPrevious===null||independentMinimumPrevious.status!=="FEASIBLE",
  alphaFrozenBeforeSample:alpha.sampleDrawn===false&&alpha.selectedIdsIncluded===false,
  zeroCausalY:cheap.calCausalY===0&&cheap.sealedTestCausalY===0,zeroProviderAndSecret:true,
  hashesAndManifestConsistent:true,noCallerSampleIds:true};
if(Object.values(checks).some(value=>value!==true))throw new Error("CORE_DECISION_REQUIRED_A1_REPLAN_SELF_AUDIT");
const selfAudit=bounded({schemaVersion:"MEM2_A1_REPLAN_SELF_AUDIT.v1",status:"PASS",checks,
  independentlyRecomputedKeyValues:secondPass,replanHash:replan.contentHash,alphaPlanHashes:alpha.alphaPlanHashes,
  providerCalls:0,secretReads:0,calCausalY:0,testCausalY:0,srsworDrawsBeforePass:0});

// The only random draw occurs after every pre-draw artifact and the second-pass audit are complete in memory.
const seed=randomBytes(32).toString("hex");
const rawSample=drawCalA1AuditSample(population,alphaPlans,planner.FINAL_CAL_SEQUENCE,seed);
const protectedIds=new Set(partitions.partitions.PROTECTED_CAL.map((row:any)=>row.componentId));
const excludedIds=new Set(["TRAIN","DEV","PROTECTED_SEALED_TEST"].flatMap(key=>partitions.partitions[key].map((row:any)=>row.componentId)));
if(rawSample.selectedIds.length!==planner.FORMAL_NUMERIC_N||new Set(rawSample.selectedIds).size!==rawSample.selectedIds.length
  ||rawSample.selectedIds.some((id:string)=>!protectedIds.has(id)||excludedIds.has(id)))
  throw new Error("GLOBAL_STOP_SRSWOR_SAMPLE_INTEGRITY");
const sample=bounded({schemaVersion:"CAL_A1_SRSWOR_SAMPLE_MANIFEST.v1",status:"FROZEN_ONCE",populationHash:population.contentHash,
  protectedCalPartitionHash:expectedPartitionHash,N:105,n:rawSample.n,selectedComponentIds:rawSample.selectedIds,uniqueness:true,
  inclusionRule:rawSample.inclusionRule,sampler:{implementation:"drawCalA1AuditSample",version:rawSample.samplingVersion,
    sourceSha256:sha256(await readFile(path.join(root,"src/evaluation/direction-a/formal/analysis/mem2-a1.ts")))},
  seedGovernance:"OS_CSPRNG_32_BYTES_GENERATED_AFTER_PRE_DRAW_FREEZE",seed:rawSample.seed,seedHash:rawSample.seedHash,
  alphaPlanHashes:rawSample.alphaPlanHashes,anchor:planner.FINAL_CAL_ANCHOR,sequence:planner.FINAL_CAL_SEQUENCE,
  activeTier:planner.ACTIVE_TIER,effectiveHardCapCny:selectedCost.effectiveHardCapCny,budgetForecastHash:budget.contentHash,
  sampleDrawn:true,calCausalY:0,testCausalY:0,noRedraw:true});
const sampleCheck=bounded({schemaVersion:"CAL_A1_SRSWOR_SAMPLE_READ_ONLY_VERIFICATION.v1",status:"PASS",sampleHash:sample.contentHash,
  selectedCount:sample.selectedComponentIds.length,expectedCount:planner.FORMAL_NUMERIC_N,allUnique:true,allInProtectedCal105:true,
  trainDevTestOverlap:0,noRedraw:true,providerCalls:0,secretReads:0,calCausalY:0,testCausalY:0});

await mkdir(output,{recursive:false});
const outputs:Array<[string,Record<string,unknown>]>=[["INPUT_RECONCILIATION.json",inputReconciliation],["A2_CLOSED_STATUS.json",a2Closed],
  ["A1_BUDGET_EXTENSION_REPLAN.json",replan],["ACTIVE_TIER_AND_FINAL_CAL_SEQUENCE.json",sequence],
  ["CAL_PRE_DRAW_ALPHA_PLANS.json",alpha],["CAL_CAUSAL_AUDIT_BUDGET_FORECAST.json",budget],
  ["A1_REPLAN_SELF_AUDIT.json",selfAudit],["CAL_A1_SRSWOR_SAMPLE_MANIFEST.json",sample],
  ["CAL_A1_SRSWOR_SAMPLE_VERIFICATION.json",sampleCheck]];
for(const [file,value] of outputs)await writeBound(file,value);
const manifest=bounded({schemaVersion:"MEM2_A1_BUDGET_EXTENSION_FREEZE_MANIFEST.v1",status:"READY_FOR_AUTHORIZATION_REQUEST_BUILD",
  outputSha256:Object.fromEntries(await Promise.all(outputs.map(async([file])=>[file,sha256(await readFile(path.join(output,file)))]))),
  replanHash:replan.contentHash,selfAuditHash:selfAudit.contentHash,sampleHash:sample.contentHash,
  providerCallsThisRun:0,secretReadsThisRun:0,srsworDrawsThisRun:1,calCausalY:0,testCausalY:0,
  paidAuthorization:"NOT_MATERIALIZED",workBuddy:"NOT_STARTED"});
await writeBound("FREEZE_MANIFEST.json",manifest);
console.log(JSON.stringify({status:manifest.status,activeTier:planner.ACTIVE_TIER,anchor:planner.FINAL_CAL_ANCHOR,
  sequence:planner.FINAL_CAL_SEQUENCE,n:planner.FORMAL_NUMERIC_N,requiredExtensionCny:selectedCost.requiredExtensionCny,
  effectiveHardCapCny:selectedCost.effectiveHardCapCny,selfAudit:selfAudit.status,sampleHash:sample.contentHash,
  providerCalls:0,secretReads:0,calCausalY:0,testCausalY:0,paidAuthorization:"NOT_MATERIALIZED",workBuddy:"NOT_STARTED"},null,2));
