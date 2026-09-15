import { hashCanonical } from "../core/canonical.js";
import { assertA1Hash, assertA1Report, bindA1, freezePredictionPopulation, requireHash,
  type A1Report, type Bound, type Policy, type PredictionPopulation } from "../analysis/mem2-a1.js";
import { devPlanningWorlds, trainingProbability, type DevEvidence } from "./mem2-scale-planner-v2.js";

export interface CandidateScore { policy:Policy; devV:number; devG:number; floorEligible:boolean;
  nRequiredDev:number|null; planningEvidenceHash:string }
export interface AnchorInput { dev:DevEvidence; policies:Policy[]; freshRegistryHash:string; freshCapacity:number;
  minimumCoverage:number; minimumAcceptedSupport:number; referenceBindings:PredictionPopulation }

/** DEV-only ranking. Common reference N is the live registry capacity. The virtual
 * reference population preserves DEV acceptance proportion (nearest integer K).
 * It is a planning population, never a CAL sample or formal evidence. */
export function scoreDevAnchor(input:AnchorInput):CandidateScore[]{
  const {dev,policies,freshCapacity:N}=input;
  assertA1Hash(dev);requireHash(input.freshRegistryHash);
  if(!Number.isSafeInteger(N)||N<1)throw new Error("FRESH_POPULATION_REGISTRY_INTEGRITY_FAILURE");
  return policies.map(policy=>{
    if(dev.policyHashes[policy.policyId]!==policy.policyHash)throw new Error("DEV_ANCHOR_POLICY_MISMATCH");
    const C=dev.rows.filter(r=>r.decisions[policy.policyId]).length/dev.rows.length;
    const devV=dev.rows.reduce((s,r)=>s+Number(r.decisions[policy.policyId])*r.thetaHatFixed4,0)/dev.rows.length;
    const devG=dev.rows.reduce((s,r)=>s+(Number(r.decisions[policy.policyId])-C)*r.thetaHatFixed4,0)/dev.rows.length;
    const floorEligible=C>=input.minimumCoverage&&dev.rows.filter(r=>r.decisions[policy.policyId]).length>=input.minimumAcceptedSupport;
    const evidence:unknown[]=[];
    let nRequiredDev:number|null=null;
    if(policy.targetCoverage<100&&devV>0&&devG>0&&floorEligible){
      let worlds:ReturnType<typeof devPlanningWorlds>=[];
      try{worlds=devPlanningWorlds(dev,policy.policyId);}catch(e){
        if((e as Error).message!=="DEV_ROBUSTNESS_SUPPORT_INSUFFICIENT")throw e;
        evidence.push("DEV_ROBUSTNESS_SUPPORT_INSUFFICIENT");
      }
      const K=Math.round(C*N);
      const rows=Array.from({length:N},(_,i)=>({componentId:`DEV_PLANNING_${String(i).padStart(10,"0")}`,
        statisticalClusterId:`DEV_PLANNING_${i}`,decisions:{[policy.policyId]:i<K},baselineAccepted:false}));
      const base=input.referenceBindings;
      const {contentHash,schemaVersion,N:oldN,coverage,baselineCoverage,...binding}=base;
      const p=freezePredictionPopulation({...binding,purpose:"SMOKE",rows,policies:[policy],
        cheapXFreezeHash:dev.contentHash,completeQualifiedPartitionHash:hashCanonical(rows.map(({componentId,statisticalClusterId})=>({componentId,statisticalClusterId})))});
      const required:number[]=[];
      for(const world of worlds){
        let found:number|null=null;
        for(let n=1;n<=N;n++){
          const probability=trainingProbability(p,policy.policyId,n,.95,world,N*policies.length*worlds.length);
          evidence.push({n,...probability});
          if(probability.status==="FEASIBLE"){found=n;break;}
        }
        if(found!==null)required.push(found);
      }
      if(worlds.length&&required.length===worlds.length)nRequiredDev=Math.max(...required);
    }
    return {policy,devV,devG,floorEligible,nRequiredDev,
      planningEvidenceHash:hashCanonical({version:"DEV_ANCHOR_COMMON_REGISTRY_N_ROUND_DEV_K.v1",devHash:dev.contentHash,
        registryHash:input.freshRegistryHash,N,policy,evidence})};
  });
}
export type CalSequence=Bound<{schemaVersion:"MEM2_DEV_ANCHOR_FIXED_SEQUENCE.v1";devEvidenceHash:string;
  scores:CandidateScore[];orderedPolicyIds:string[];status:"FROZEN"|"NO_CANDIDATE_READY_FOR_CAL";
  evidencePurpose:"DEV";preCalY:true;anchorPolicyId:string|null}>;
export function freezeCalSequence(scores:CandidateScore[],devEvidenceHash:string):CalSequence{
  requireHash(devEvidenceHash);
  if(new Set(scores.map(s=>s.policy.policyId)).size!==scores.length)throw new Error("CAL_DUPLICATE_POLICY_ID");
  for(const score of scores){
    requireHash(score.planningEvidenceHash);
    if(!Number.isFinite(score.devV)||!Number.isFinite(score.devG)||score.nRequiredDev!==null&&(!Number.isInteger(score.nRequiredDev)||score.nRequiredDev<1))throw new Error("CAL_ANCHOR_SCORE_INVALID");
  }
  // Frozen threshold dedup: keep highest coverage label before anchor ranking.
  const dedup=scores.filter(s=>!scores.some(t=>t.policy.threshold===s.policy.threshold&&
    (t.policy.targetCoverage>s.policy.targetCoverage||t.policy.targetCoverage===s.policy.targetCoverage&&hashCanonical(t.policy)<hashCanonical(s.policy))));
  const eligible=dedup.filter(s=>s.policy.targetCoverage<100&&s.devV>0&&s.devG>0&&s.floorEligible&&s.nRequiredDev!==null)
    .sort((a,b)=>a.nRequiredDev!-b.nRequiredDev!||b.policy.targetCoverage-a.policy.targetCoverage||
      (hashCanonical(a.policy)<hashCanonical(b.policy)?-1:1));
  const anchor=eligible[0];
  const orderedPolicyIds=anchor?[anchor.policy.policyId,...dedup.filter(s=>s.policy.targetCoverage>anchor.policy.targetCoverage&&s.policy.targetCoverage<100)
    .sort((a,b)=>a.policy.targetCoverage-b.policy.targetCoverage||(hashCanonical(a.policy)<hashCanonical(b.policy)?-1:1)).map(s=>s.policy.policyId)]:[];
  return bindA1({schemaVersion:"MEM2_DEV_ANCHOR_FIXED_SEQUENCE.v1",devEvidenceHash,scores,orderedPolicyIds,
    status:anchor?"FROZEN":"NO_CANDIDATE_READY_FOR_CAL",evidencePurpose:"DEV",preCalY:true,anchorPolicyId:anchor?.policy.policyId??null});
}
export function evaluateCalSequence(sequence:CalSequence,report:A1Report,floors:{minimumCoverage:number;minimumAcceptedSupport:number}){
  assertA1Hash(sequence);assertA1Report(report);
  if(sequence.status!=="FROZEN"||report.population.purpose!=="CAL")throw new Error("CAL_CAUSAL_Y_CLOSED_NO_DEV_ANCHOR");
  if(freezeCalSequence(sequence.scores,sequence.devEvidenceHash).contentHash!==sequence.contentHash)throw new Error("CAL_ORDER_DERIVATION_MISMATCH");
  if(!Number.isFinite(floors.minimumCoverage)||floors.minimumCoverage<0||floors.minimumCoverage>1||!Number.isSafeInteger(floors.minimumAcceptedSupport)||floors.minimumAcceptedSupport<1)throw new Error("CAL_FLOORS_INVALID");
  const reached=[];
  let selectedPolicyId:string|null=null;
  for(const id of sequence.orderedPolicyIds){
    const policy=report.population.policies.find(p=>p.policyId===id);
    if(!policy||hashCanonical(policy)!==hashCanonical(sequence.scores.find(s=>s.policy.policyId===id)!.policy))throw new Error("CAL_FROZEN_POLICY_MISMATCH");
    const {V,G}=report.tests[id];
    const statisticalPass=V.pass&&G.pass;
    const coveragePass=report.population.coverage[id]>=floors.minimumCoverage;
    const support=report.population.rows.filter(r=>r.decisions[id]).length;
    const supportPass=support>=floors.minimumAcceptedSupport;
    reached.push({policyId:id,statisticalPass,coveragePass,supportPass});
    if(!statisticalPass)break;
    if(coveragePass&&supportPass)selectedPolicyId=id;
  }
  return bindA1({schemaVersion:"MEM2_CAL_FIXED_SEQUENCE_REPORT.v1",sequenceHash:sequence.contentHash,
    inferenceReportHash:report.contentHash,reached,selectedPolicyId,status:selectedPolicyId?"CERTIFIED_OPERATING_POINT":"NO_CERTIFIED_OPERATING_POINT"});
}
