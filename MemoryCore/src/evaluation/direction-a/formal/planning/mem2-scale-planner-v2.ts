import { hashCanonical } from "../core/canonical.js";
import { a1Bound, a1Random, assertA1Hash, assertPredictionPopulation, bindA1, freezeAlphaPlan, populationWeights,
  requireHash, srsworIndices, type AlphaPlan, type Bound, type PredictionPopulation } from "../analysis/mem2-a1.js";

export const PLANNER_V2 = "MEM2-A1-SCALE-PLANNER-V2-2026-09-09";
export const NUMERICS = Object.freeze({ version:"SHA256_MC_HOEFFDING_99_UNIFORM.v1", replications:10000, assurance:.80 });
export type Stress = .95 | .90 | .99;
export function unavailableStressCount(n:number,r:Stress):number {
  if(!Number.isSafeInteger(n)||n<1||![.95,.90,.99].includes(r)) throw new Error("PLANNER_STRESS_INVALID");
  // Integer percent arithmetic implements mathematical floor without .90 binary rounding errors.
  return Math.floor(n*(100-Math.round(r*100))/100);
}
export interface DevRow { componentId:string; thetaHatFixed4:number; decisions:Record<string,boolean> }
export type DevEvidence=Bound<{purpose:"DEV"; fixed4:true; policyHashes:Record<string,string>; rows:DevRow[]}>;
export function devPlanningWorlds(dev:DevEvidence,policyId:string) {
  assertA1Hash(dev);
  if(dev.purpose!=="DEV"||dev.fixed4!==true||!dev.rows.length
    ||new Set(dev.rows.map(r=>r.componentId)).size!==dev.rows.length) throw new Error("PLANNER_DEV_ONLY_REQUIRED");
  for(const row of dev.rows) if(!row.componentId||!Number.isFinite(row.thetaHatFixed4)||Math.abs(row.thetaHatFixed4)>1
    ||typeof row.decisions[policyId]!=="boolean") throw new Error("PLANNER_DEV_ROW_INVALID");
  return [null,...dev.rows.map(r=>r.componentId)].map(omit=>{
    const rows=dev.rows.filter(r=>r.componentId!==omit);
    const accept=rows.filter(r=>r.decisions[policyId]).map(r=>r.thetaHatFixed4);
    const reject=rows.filter(r=>!r.decisions[policyId]).map(r=>r.thetaHatFixed4);
    if(!accept.length||!reject.length) throw new Error("DEV_ROBUSTNESS_SUPPORT_INSUFFICIENT");
    return {world:omit===null?"DEV_FULL_WORLD":`LOO:${omit}`,accept,reject};
  });
}
export interface BudgetInput {
  ledgerHash:string; registryHash:string; reservationAuthorityHash:string;
  alreadyPaid:number; protectedExposure:number; smokeReserve:number; technicalReserve:number;
  downstreamReservedCost:number; activeDownstreamReserveFloor:number;
  normalExpected:number; normalP95:number; fixed4Expected:number; max5P95:number;
  normalAlreadyPurchasedIds:string[]; freshComponentIds:string[]; hardCapCny:30|53;
  authorizedExtensionMaxCny?:15; maxExtendedHardCapCny?:68;
}
export function planCost(b:BudgetInput,p:PredictionPopulation,n:number){
  for(const h of [b.ledgerHash,b.registryHash,b.reservationAuthorityHash]) requireHash(h);
  for(const [key,value] of Object.entries(b)) if(typeof value==="number"&&(!Number.isFinite(value)||value<0)) throw new Error(`CNY30_LEDGER_INTEGRITY_FAILURE:${key}`);
  const extensionEnabled=b.authorizedExtensionMaxCny!==undefined||b.maxExtendedHardCapCny!==undefined;
  if(![30,53].includes(b.hardCapCny)||b.downstreamReservedCost<b.activeDownstreamReserveFloor
    ||(extensionEnabled&&(b.hardCapCny!==53||b.authorizedExtensionMaxCny!==15||b.maxExtendedHardCapCny!==68)))
    throw new Error("MEM2_RESERVE_REDUCTION_FORBIDDEN");
  if(new Set(b.freshComponentIds).size!==b.freshComponentIds.length||p.rows.some(r=>!b.freshComponentIds.includes(r.componentId)))
    throw new Error("FRESH_POPULATION_REGISTRY_INTEGRITY_FAILURE");
  if(new Set(b.normalAlreadyPurchasedIds).size!==b.normalAlreadyPurchasedIds.length
    ||b.normalAlreadyPurchasedIds.some(id=>!p.rows.some(r=>r.componentId===id))) throw new Error("PLANNER_NORMAL_REUSE_ID_INVALID");
  const normalCount=p.N-b.normalAlreadyPurchasedIds.length;
  const normal=normalCount*Math.max(b.normalExpected,b.normalP95*1.2);
  const audit=n*Math.max(b.fixed4Expected,b.max5P95*1.2);
  const reserves=b.smokeReserve+b.technicalReserve+b.downstreamReservedCost;
  const base=b.alreadyPaid+b.protectedExposure+reserves;
  if(base>b.hardCapCny+1e-12) throw new Error("MEM2_LEDGER_HARD_CAP_EXCEEDED");
  const expectedCost=normalCount*b.normalExpected+n*b.fixed4Expected;
  const conservativeCost=normal+audit;
  const minimumRequiredHardCapCny=base+conservativeCost;
  const requiredExtensionCny=Math.max(0,minimumRequiredHardCapCny-b.hardCapCny);
  const effectiveHardCapCny=b.hardCapCny+requiredExtensionCny;
  const legalUnderBaseHardCap=minimumRequiredHardCapCny<=b.hardCapCny+1e-12&&n<=p.N;
  const legalUnderAuthorizedExtension=extensionEnabled&&requiredExtensionCny<=b.authorizedExtensionMaxCny!+1e-12
    &&effectiveHardCapCny<=b.maxExtendedHardCapCny!+1e-12&&n<=p.N;
  return {already_paid:b.alreadyPaid,protected_exposure:b.protectedExposure,new_incremental_NORMAL_cheapX:normal,
    new_incremental_NORMAL_cheapX_count:normalCount,
    new_incremental_fixed4_causal_audit:audit,smoke_reserve:b.smokeReserve,technical_reserve:b.technicalReserve,
    downstream_reserved_cost:b.downstreamReservedCost,expected_cost:expectedCost,conservative_cost:conservativeCost,
    gross_design_cost:p.N*Math.max(b.normalExpected,b.normalP95*1.2)+audit,new_incremental_cost:conservativeCost,
    Mem2_total_cost:minimumRequiredHardCapCny,minimumRequiredHardCapCny,requiredExtensionCny,effectiveHardCapCny,
    baseHardCapCny:b.hardCapCny,authorizedExtensionMaxCny:b.authorizedExtensionMaxCny??0,
    maxExtendedHardCapCny:b.maxExtendedHardCapCny??b.hardCapCny,legalUnderBaseHardCap,legalUnderAuthorizedExtension,
    fresh_population_capacity:b.freshComponentIds.length,population_N:p.N,audit_n:n,
    legal:legalUnderBaseHardCap||legalUnderAuthorizedExtension};
}
/** Metric-wise adverse removal; enumerate all possible accepted/rejected removal counts.
 * Within a fixed count/stratum w^2 is constant, so removing largest w*d+|w| is exact. */
export function stressedBound(plan:AlphaPlan,w:number[],effects:number[],r:Stress){
  const q=unavailableStressCount(w.length,r);
  const groups=new Map<number,number[]>();
  w.forEach((v,i)=>groups.set(v,[...(groups.get(v)??[]),i]));
  if(groups.size>2) throw new Error("PLANNER_V_G_TWO_STRATA_REQUIRED");
  const strata=[...groups.values()].map(ids=>ids.sort((i,j)=>(w[j]*effects[j]+Math.abs(w[j]))-(w[i]*effects[i]+Math.abs(w[i]))));
  let worst=a1Bound(plan,w,effects);
  for(let total=1;total<=q;total++)for(let first=0;first<=total;first++){
    const second=total-first;
    if(first>strata[0].length||second>(strata[1]?.length??0))continue;
    const d:Array<number|null>=[...effects];
    for(const i of [...strata[0].slice(0,first),...(strata[1]?.slice(0,second)??[])]) d[i]=null;
    const value=a1Bound(plan,w,d);
    if(value.lowerConfidenceBound95<worst.lowerConfidenceBound95)worst=value;
  }
  return worst;
}
function logChoose(N:number,k:number){
  if(k<0||k>N)return -Infinity;
  let sum=0;
  for(let i=1;i<=Math.min(k,N-k);i++)sum+=Math.log(N-i+1)-Math.log(i);
  return sum;
}
export function classifyPlanningProbability(lower:number,upper:number){
  return lower>=.80?"FEASIBLE":upper<.80?"INFEASIBLE":"PLANNING_PROBABILITY_NUMERICALLY_INDETERMINATE";
}
export function minimumFeasibleProbability(p:PredictionPopulation,id:string,n:number,r:Stress){
  const V=freezeAlphaPlan(p,id,"V",n),G=freezeAlphaPlan(p,id,"G",n);
  const K=p.rows.filter(row=>row.decisions[id]).length,C=K/p.N;
  let probability=0,mass=0;
  for(let k=Math.max(0,n-(p.N-K));k<=Math.min(K,n);k++){
    const weight=Math.exp(logChoose(K,k)+logChoose(p.N-K,n-k)-logChoose(p.N,n));
    mass+=weight;
    const a=Array.from({length:n},(_,i)=>i<k?1:0),d=a.map(v=>v?1:-1);
    if(stressedBound(V,a,d,r).pass&&stressedBound(G,a.map(v=>v-C),d,r).pass)probability+=weight;
  }
  if(Math.abs(mass-1)>1e-9)throw new Error("PLANNER_HYPERGEOMETRIC_NUMERICAL_FAILURE");
  probability/=mass;
  const error=1e-12*(p.N+1);
  const lower=Math.max(0,probability-error),upper=Math.min(1,probability+error);
  return {probability,lower,upper,status:classifyPlanningProbability(lower,upper),method:"EXACT_HYPERGEOMETRIC_FLOAT64",stress:r};
}
export function trainingProbability(p:PredictionPopulation,id:string,n:number,r:Stress,
  world:ReturnType<typeof devPlanningWorlds>[number],familySize:number){
  const V=freezeAlphaPlan(p,id,"V",n),G=freezeAlphaPlan(p,id,"G",n);
  const wV=populationWeights(p,id,"V"),wG=populationWeights(p,id,"G");
  const seed=hashCanonical({version:NUMERICS.version,population:p.contentHash,id,n,r,world});
  const random=a1Random(seed);
  let passed=0;
  for(let j=0;j<NUMERICS.replications;j++){
    const indices=srsworIndices(p.N,n,random),a=indices.map(i=>wV[i]);
    const effects=a.map(v=>{const pool=v?world.accept:world.reject;return pool[random(pool.length)];});
    if(stressedBound(V,a,effects,r).pass&&stressedBound(G,indices.map(i=>wG[i]),effects,r).pass)passed++;
  }
  const probability=passed/NUMERICS.replications;
  const radius=Math.sqrt(Math.log(2*Math.max(1,familySize)/.01)/(2*NUMERICS.replications));
  const lower=Math.max(0,probability-radius),upper=Math.min(1,probability+radius);
  return {probability,lower,upper,status:classifyPlanningProbability(lower,upper),seed,replications:NUMERICS.replications,
    numericalConfidence:.99,method:NUMERICS.version,stress:r,world:world.world};
}
export interface DevelopmentPolicyBinding {
  policyId:string; targetCoverage:number; admission:"ADMITTED"|"EXCLUDED";
  developmentAdmissionPolicyHash:string; developmentPolicyHash:string;
}
export interface FinalPolicyProvenanceBinding {
  policyId:string; targetCoverage:number; developmentAdmissionPolicyHash:string;
  finalExecutionPolicyHash:string; finalPolicyHash:string;
}
export interface OperationalFloorBinding {
  policyId:string; targetCoverage:number; finalExecutionPolicyHash:string;
  actualCalCoverage:number; acceptedCount:number;
  operationalEligibility:"ELIGIBLE"|"EXCLUDED";
}
export function freezePostCalXFinalSequence(input:{activeTier:"TRAINING_FIRST"|"MINIMUM_FEASIBLE"|"NONE";
  candidates:Array<{policyId:string;targetCoverage:number;policyHash:string;trainingFirstRequiredN:number|null;minimumRequiredN:number|null}>}){
  const {activeTier,candidates}=input;
  if(new Set(candidates.map(r=>r.policyId)).size!==candidates.length)throw new Error("POSTCALX_SEQUENCE_DUPLICATE_POLICY_ID");
  const nOf=(row:typeof candidates[number])=>activeTier==="TRAINING_FIRST"?row.trainingFirstRequiredN:
    activeTier==="MINIMUM_FEASIBLE"?row.minimumRequiredN:null;
  const ranked=candidates.filter(row=>nOf(row)!==null).sort((a,b)=>nOf(a)!-nOf(b)!
    ||b.targetCoverage-a.targetCoverage||(hashCanonical(a)<hashCanonical(b)?-1:1));
  const anchor=ranked[0]??null;
  const orderedPolicyIds=anchor?[anchor.policyId,...candidates.filter(row=>row.targetCoverage>anchor.targetCoverage)
    .sort((a,b)=>a.targetCoverage-b.targetCoverage||(hashCanonical(a)<hashCanonical(b)?-1:1)).map(row=>row.policyId)]:[];
  return bindA1({schemaVersion:"MEM2_POSTCALX_FINAL_SEQUENCE.v1",activeTier,anchorPolicyId:anchor?.policyId??null,
    formalCalAuditN:anchor?nOf(anchor):null,orderedPolicyIds,
    tieBreak:"MIN_FINITE_REQUIRED_N_THEN_HIGHER_TARGET_COVERAGE_THEN_CANONICAL_HASH"});
}
export function selectPostCalXActiveTier(rows:Array<{requiredN:number|null;minimumRequiredN:number|null}>){
  if(rows.some(row=>row.requiredN!==null))return {activeTier:"TRAINING_FIRST" as const,trainingFirstAssurance:"ACHIEVED" as const,claimDowngrade:null};
  if(rows.some(row=>row.minimumRequiredN!==null))return {activeTier:"MINIMUM_FEASIBLE" as const,trainingFirstAssurance:"NOT_ACHIEVED" as const,
    claimDowngrade:"PLANNING_STABILITY_ONLY" as const};
  return {activeTier:"NONE" as const,trainingFirstAssurance:"NOT_ACHIEVED" as const,claimDowngrade:null};
}
export interface PlannerInput {
  population:PredictionPopulation; dev:DevEvidence; budget:BudgetInput;
  trainDevFreezeHash:string; finalPolicyFreezeHash:string; operationalFloorReportHash:string;
  auditDrawOccurred:false; targetCausalYRevealed:false;
  developmentPolicies:DevelopmentPolicyBinding[];
  finalPolicyProvenance:FinalPolicyProvenanceBinding[];
  operationalFloors:OperationalFloorBinding[];
  floors:{minimumCoverage:number;minimumAcceptedSupport:number};
}
export function evaluateA2Trigger(input: {preYInputsComplete:boolean; purpose:"CAL"|"SEALED_TEST"|"SMOKE";
  auditDrawOccurred:boolean; targetCausalYRevealed:boolean; minimumStatus:string}){
  if(input.auditDrawOccurred||input.targetCausalYRevealed)throw new Error("A2_POST_DRAW_OR_Y_SWITCH_FORBIDDEN");
  if(!input.preYInputsComplete||input.purpose!=="CAL")return "NOT_EVALUATED_PREY_INPUTS_ABSENT";
  if(input.minimumStatus==="FEASIBLE")return "FORBIDDEN";
  if(input.minimumStatus==="INFEASIBLE")return "A2_ZERO_API_QUALIFICATION_ALLOWED";
  return "PLANNING_PROBABILITY_NUMERICALLY_INDETERMINATE";
}
export function planMem2ScaleV2(input?:PlannerInput){
  if(!input)return bindA1({version:PLANNER_V2,PLANNING_ONLY:true,FORMAL_CONFIDENCE_EVIDENCE:false,
    FORMAL_NUMERIC_N:"PENDING_LAWFUL_PREY_INPUTS",A2_TRIGGER:"NOT_EVALUATED_PREY_INPUTS_ABSENT",A2_METHOD:"NOT_ACTIVE",
    tiers:["MINIMUM_FEASIBLE","TRAINING_FIRST","STATISTICS_STRONG"],defaultTier:"TRAINING_FIRST"});
  const allowed=["population","dev","budget","trainDevFreezeHash","finalPolicyFreezeHash","operationalFloorReportHash","auditDrawOccurred","targetCausalYRevealed","developmentPolicies","finalPolicyProvenance","operationalFloors","floors"];
  if(Object.keys(input).some(k=>!allowed.includes(k)))throw new Error("PLANNER_UNDECLARED_OR_CAL_TEST_Y_INPUT_FORBIDDEN");
  if(input.auditDrawOccurred!==false||input.targetCausalYRevealed!==false)throw new Error("PLANNER_PRE_DRAW_PRE_Y_REQUIRED");
  for(const h of [input.trainDevFreezeHash,input.finalPolicyFreezeHash,input.operationalFloorReportHash])requireHash(h);
  const p=input.population;
  assertPredictionPopulation(p);
  if(input.budget.hardCapCny!==53)throw new Error("POSTCALX_STALE_PRECAL_LEDGER_REJECTED");
  const purchased=[...input.budget.normalAlreadyPurchasedIds].sort(),populationIds=p.rows.map(r=>r.componentId).sort();
  if(hashCanonical(purchased)!==hashCanonical(populationIds))throw new Error("POSTCALX_NORMAL_PURCHASED_SET_MISMATCH");
  assertA1Hash(input.dev);
  if(input.dev.purpose!=="DEV")throw new Error("PLANNER_DEV_ONLY_REQUIRED");
  if(!Number.isFinite(input.floors.minimumCoverage)||input.floors.minimumCoverage<0||input.floors.minimumCoverage>1
    ||!Number.isSafeInteger(input.floors.minimumAcceptedSupport)||input.floors.minimumAcceptedSupport<1)throw new Error("PLANNER_FROZEN_FLOORS_REQUIRED");
  const unique=(rows:{policyId:string}[],label:string)=>{
    if(new Set(rows.map(r=>r.policyId)).size!==rows.length)throw new Error(`PLANNER_DUPLICATE_${label}_POLICY_ID`);
  };
  unique(input.developmentPolicies,"DEVELOPMENT");unique(input.finalPolicyProvenance,"PROVENANCE");unique(input.operationalFloors,"OPERATIONAL_FLOOR");
  const development=new Map(input.developmentPolicies.map(r=>[r.policyId,r]));
  const provenance=new Map(input.finalPolicyProvenance.map(r=>[r.policyId,r]));
  const operational=new Map(input.operationalFloors.map(r=>[r.policyId,r]));
  const eligibility=p.policies.map(q=>{
    const d=development.get(q.policyId),link=provenance.get(q.policyId),floor=operational.get(q.policyId);
    const reasons:string[]=[];
    if(d?.admission!=="ADMITTED")reasons.push("NOT_DEVELOPMENT_ADMITTED");
    if(!d||!link||d.developmentAdmissionPolicyHash!==link.developmentAdmissionPolicyHash
      ||d.targetCoverage!==link.targetCoverage)reasons.push("DEVELOPMENT_FINAL_PROVENANCE_INVALID");
    if(!link||link.finalPolicyHash!==q.policyHash||link.targetCoverage!==q.targetCoverage)reasons.push("FINAL_EXECUTION_POLICY_BINDING_INVALID");
    if(!floor||!link||floor.finalExecutionPolicyHash!==link.finalExecutionPolicyHash
      ||floor.targetCoverage!==q.targetCoverage)reasons.push("CAL_X_FINAL_POLICY_BINDING_INVALID");
    if(floor?.operationalEligibility!=="ELIGIBLE"||floor.actualCalCoverage<input.floors.minimumCoverage
      ||floor.acceptedCount<input.floors.minimumAcceptedSupport)reasons.push("CAL_X_OPERATIONAL_FLOOR_FAIL");
    if(q.targetCoverage>=100)reasons.push("DESCRIPTIVE_ONLY");
    return {policyId:q.policyId,targetCoverage:q.targetCoverage,developmentAdmissionPolicyHash:d?.developmentAdmissionPolicyHash??null,
      finalExecutionPolicyHash:link?.finalExecutionPolicyHash??null,actualCalCoverage:floor?.actualCalCoverage??null,
      acceptedCount:floor?.acceptedCount??null,status:reasons.length?"EXCLUDED" as const:"ELIGIBLE" as const,reasons};
  });
  const candidates=p.policies.filter(q=>eligibility.find(r=>r.policyId===q.policyId)?.status==="ELIGIBLE");
  if(!candidates.length)throw new Error("NO_CANDIDATE_READY_FOR_CAL");
  const costs=Array.from({length:p.N},(_,i)=>planCost(input.budget,p,i+1));
  const legal=costs.filter(c=>c.legal).map(c=>c.audit_n);
  const rows=candidates.map(policy=>{
    const developmentPolicyHash=development.get(policy.policyId)!.developmentPolicyHash;
    if(input.dev.policyHashes[policy.policyId]!==developmentPolicyHash)throw new Error("PLANNER_DEV_POLICY_BINDING_MISMATCH");
    let worlds:ReturnType<typeof devPlanningWorlds>;
    try{worlds=devPlanningWorlds(input.dev,policy.policyId);}catch(e){
      if((e as Error).message!=="DEV_ROBUSTNESS_SUPPORT_INSUFFICIENT")throw e;
      worlds=[];
    }
    const minimum=legal.map(n=>({n,primary:minimumFeasibleProbability(p,policy.policyId,n,.95)}));
    const minRow=minimum.find(q=>q.primary.status==="FEASIBLE");
    const minimumStatus=minRow?"FEASIBLE":minimum.some(q=>q.primary.status.includes("INDETERMINATE"))?"PLANNING_PROBABILITY_NUMERICALLY_INDETERMINATE":"INFEASIBLE";
    // MINIMUM_FEASIBLE uses the pointwise ideal accepted/rejected effects (+1/-1),
    // so an infeasible minimum row is an upper-bound proof that no DEV world can
    // achieve TRAINING_FIRST at a legal N. Avoid Monte Carlo that cannot affect tier selection.
    const training=minRow?worlds.map(world=>{
      const attempts=[];
      // The ideal +1/-1 MINIMUM_FEASIBLE construction is an upper bound on
      // every empirical DEV world, so no TRAINING_FIRST world can pass below
      // its first feasible n. Skipping those impossible n values changes only
      // runtime, never the frozen statistical rule or result.
      for(const n of legal.filter(n=>n>=minRow.n)){
        const result=trainingProbability(p,policy.policyId,n,.95,world,candidates.length*legal.length*worlds.length*3);
        attempts.push({n,...result});
        if(result.status==="FEASIBLE")break;
      }
      return {world:world.world,attempts,requiredN:attempts.find(q=>q.status==="FEASIBLE")?.n??null};
    }):[];
    const requiredN=training.length&&training.every(q=>q.requiredN!==null)?Math.max(...training.map(q=>q.requiredN!)):null;
    const reportN=requiredN??minRow?.n??legal.at(-1)??null;
    const stress=reportN===null?[]:([.95,.90,.99] as const).map(r=>({r,
      minimum:minimumFeasibleProbability(p,policy.policyId,reportN,r),
      training:minRow?worlds.map(world=>trainingProbability(p,policy.policyId,reportN,r,world,candidates.length*Math.max(1,legal.length)*Math.max(1,worlds.length)*3)):[]}));
    const deltaPlan=reportN===null?null:freezeAlphaPlan(p,policy.policyId,"DeltaV",reportN);
    const allWorldsPassAtSelected=requiredN!==null&&stress[0].training.every(w=>w.status==="FEASIBLE");
    const selectedN=allWorldsPassAtSelected?requiredN:null;
    // Report the strongest still-legal scale even when TRAINING_FIRST is not achieved.
    // This is descriptive only and cannot change the active tier, anchor, or sequence.
    const strongN=legal.at(-1)??null;
    return {policyId:policy.policyId,minimumStatus,minimumRequiredN:minRow?.n??null,minimum,
      trainingStatus:!worlds.length?"DEV_ROBUSTNESS_SUPPORT_INSUFFICIENT":selectedN===null?"NO_QUALIFIED_SCALE": "FEASIBLE",
      training,requiredN:selectedN,stress,statisticsStrongN:strongN,
      statisticsStrongMargins:strongN===null?null:{V:freezeAlphaPlan(p,policy.policyId,"V",strongN).plannedMargin,G:freezeAlphaPlan(p,policy.policyId,"G",strongN).plannedMargin},
      deltaVPlanningOnly:{forcesN:false,triggersA2:false,selectedTestScale:p.purpose==="SEALED_TEST"?reportN:null,
        plannedMargin:deltaPlan?.plannedMargin??null}};
  });
  const minimumStatus=rows.some(r=>r.minimumStatus==="FEASIBLE")?"FEASIBLE":rows.some(r=>r.minimumStatus.includes("INDETERMINATE"))?"PLANNING_PROBABILITY_NUMERICALLY_INDETERMINATE":"INFEASIBLE";
  const tier=selectPostCalXActiveTier(rows),activeTier=tier.activeTier;
  const sequence=freezePostCalXFinalSequence({activeTier,candidates:candidates.map(policy=>({policyId:policy.policyId,
    targetCoverage:policy.targetCoverage,policyHash:policy.policyHash,trainingFirstRequiredN:rows.find(r=>r.policyId===policy.policyId)!.requiredN,
    minimumRequiredN:rows.find(r=>r.policyId===policy.policyId)!.minimumRequiredN}))});
  return bindA1({version:PLANNER_V2,PLANNING_ONLY:true,FORMAL_CONFIDENCE_EVIDENCE:false,inputHash:hashCanonical(input),
    tiers:["MINIMUM_FEASIBLE","TRAINING_FIRST","STATISTICS_STRONG"],defaultTier:"TRAINING_FIRST",eligibility,rows,costs,
    ACTIVE_TIER:activeTier,TRAINING_FIRST_ASSURANCE:tier.trainingFirstAssurance,CLAIM_DOWNGRADE:tier.claimDowngrade,
    FINAL_CAL_ANCHOR:sequence.anchorPolicyId,FINAL_CAL_SEQUENCE:sequence.orderedPolicyIds,FORMAL_NUMERIC_N:sequence.formalCalAuditN,
    finalSequenceHash:sequence.contentHash,
    tieBreak:"MIN_FINITE_REQUIRED_N_THEN_HIGHER_TARGET_COVERAGE_THEN_CANONICAL_POLICY_HASH",
    stage:p.purpose,populationHash:p.contentHash,A2_TRIGGER:evaluateA2Trigger({preYInputsComplete:true,purpose:p.purpose,
      auditDrawOccurred:false,targetCausalYRevealed:false,minimumStatus}),A2_METHOD:"NOT_ACTIVE",numerics:NUMERICS});
}
