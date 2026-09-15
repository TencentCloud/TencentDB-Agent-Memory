import { describe,it,expect } from "vitest";
import { hashCanonical } from "./core/canonical.js";
import { FROZEN_DESIGN_BINDING } from "./config/frozen-design.js";
import { a1Bound,a1Margins,a1Rho,bindA1,drawAuditSample,freezeAlphaPlan,freezePredictionPopulation,
  auditReferenceStatus,inferA1, type PopulationInput } from "./analysis/mem2-a1.js";
import { classifyPlanningProbability,devPlanningWorlds,evaluateA2Trigger,minimumFeasibleProbability,
  planMem2ScaleV2,stressedBound,unavailableStressCount } from "./planning/mem2-scale-planner-v2.js";
import { evaluateSealedTestGate } from "./analysis/continuous-aggregates.js";
import {a1ComponentTest,evaluateCalCandidateIut} from "./analysis/continuous-aggregates.js";
import {buildMem2ContinuousReferenceArtifact,type Mem2ReferencePairSlot} from "./teacher/mem2-continuous-reference.js";
import {freezeCalSequence,evaluateCalSequence,type CandidateScore} from "./planning/mem2-cal-sequence.js";
import {trainingProbability} from "./planning/mem2-scale-planner-v2.js";
import {assertSmokeAuthorization} from "./acquisition/mem2-v71-smoke-gate.js";

const H=hashCanonical("test-only");
export function fixturePopulation(N=20,K=10){
  const rows=Array.from({length:N},(_,i)=>({componentId:`c${String(i).padStart(4,"0")}`,statisticalClusterId:`s${i}`,
    decisions:{p:i<K},baselineAccepted:false}));
  return freezePredictionPopulation({purpose:"CAL",environment:"Mem2",rows,
    policies:[{policyId:"p",predictionVersion:"test",policyHash:H,threshold:.5,targetCoverage:50}],
    completeQualifiedPartitionHash:hashCanonical(rows.map(({componentId,statisticalClusterId})=>({componentId,statisticalClusterId}))),
    authorityHashes:{test:H},frozenDesignBindingHash:FROZEN_DESIGN_BINDING.contentHash,sourceSnapshotCodeHash:H,
    profileHash:H,protocolHash:H,verifierHash:H,cheapXFreezeHash:H,preY:true});
}
const plans=(p:ReturnType<typeof fixturePopulation>,n:number)=>(["V","G","DeltaV"] as const).map(m=>freezeAlphaPlan(p,"p",m,n));
function fixtureReport(p=fixturePopulation(80,40)){
  const alpha=p.policies.flatMap(q=>(["V","G","DeltaV"] as const).map(m=>freezeAlphaPlan(p,q.policyId,m,p.N)));
  const sample=drawAuditSample(p,alpha,"bound-fixture");
  const refs=sample.selectedIds.map(id=>{
    const row=p.rows.find(r=>r.componentId===id)!;
    const slots:Mem2ReferencePairSlot[]=Array.from({length:4},(_,i)=>({pairId:`${id}:${i+1}`,pairIndex:i+1,
      full:{arm:"FULL",observation:"SCIENTIFICALLY_OBSERVED",utility:row.decisions.p?1:0,strictPass:false,attemptId:`${id}F${i}`,rawCompletionHash:H,outcomeHash:H},
      remove:{arm:"REMOVE",observation:"SCIENTIFICALLY_OBSERVED",utility:row.decisions.p?0:1,strictPass:false,attemptId:`${id}R${i}`,rawCompletionHash:H,outcomeHash:H}}));
    return buildMem2ContinuousReferenceArtifact({causalGroupId:id,statisticalClusterId:row.statisticalClusterId,slots,protocolHash:H,
      authorityBindingHash:FROZEN_DESIGN_BINDING.contentHash,profileHash:H,snapshotHash:H,verifierHash:H});
  });
  return inferA1(p,sample,alpha,refs);
}
describe("Mem2 A1 population and sampling",()=>{
  it("binds full-population Coverage independently of sample composition",()=>{
    const p=fixturePopulation();
    const a=drawAuditSample(p,plans(p,1),"a"),b=drawAuditSample(p,plans(p,1),"b");
    expect(p.coverage.p).toBe(.5);expect(a.populationHash).toBe(b.populationHash);
  });
  it("draws deterministically without replacement",()=>{
    const p=fixturePopulation(),a=drawAuditSample(p,plans(p,10),"seed");
    expect(drawAuditSample(p,plans(p,10),"seed")).toEqual(a);expect(new Set(a.selectedIds).size).toBe(10);
  });
  it("rejects duplicate components",()=>{
    const p=fixturePopulation();expect(()=>freezePredictionPopulation({...p,rows:[p.rows[0],p.rows[0]]})).toThrow(/DUPLICATE/);
  });
  it("rejects missing population identities",()=>{
    const p=fixturePopulation();expect(()=>freezePredictionPopulation({...p,rows:p.rows.slice(1)})).toThrow(/MISSING/);
  });
  it("keeps unsampled distinct from technical missing",()=>{
    const p=fixturePopulation(),s=drawAuditSample(p,plans(p,1),"a");
    expect(auditReferenceStatus(s,p.rows.find(r=>!s.selectedIds.includes(r.componentId))!.componentId)).toBe("NOT_SELECTED_FOR_CAUSAL_AUDIT");
  });
  it("requires every candidate and metric split before drawing",()=>{
    const p=fixturePopulation();expect(()=>drawAuditSample(p,plans(p,5).slice(1),"s")).toThrow(/SPLITS_REQUIRED/);
  });
  it("rejects changed alpha provenance",()=>{
    const p=fixturePopulation(),a=plans(p,5);a[0]={...a[0],alphaM:.049};expect(()=>drawAuditSample(p,a,"s")).toThrow(/MISMATCH/);
  });
  it("does not accept post-Y population freezes",()=>{
    expect(()=>freezePredictionPopulation({...fixturePopulation(),preY:false} as unknown as PopulationInput)).toThrow(/PREY/);
  });
});
describe("exact A1 and pre-sampling alpha",()=>{
  it.each([0,20])("accept endpoint K=%i has G exactly zero",K=>{
    const p=fixturePopulation(20,K),plan=freezeAlphaPlan(p,"p","G",20);
    expect(a1Bound(plan,Array(20).fill(0),Array(20).fill(1)).lowerConfidenceBound95).toBe(0);
    expect(plan.alphaM).toBe(.025);
  });
  it("n=1 uses the first rho branch",()=>expect(a1Rho(20,1)).toBe(1));
  it("n=N has zero sampling margin",()=>expect(a1Margins(20,20,1,20,.025).mS).toBe(0));
  it("uses the frozen finite-population correction",()=>{
    expect(a1Rho(20,10)).toBe(.55);expect(a1Rho(20,11)).toBeCloseTo((1-11/20)*(1+1/11),14);
  });
  it("uses -abs(w) for unavailable and no measurement credit",()=>{
    const plan=freezeAlphaPlan(fixturePopulation(2,1),"p","G",2);
    const r=a1Bound(plan,[.5,-.5],[null,null]);expect(r.estimate).toBe(-.5);expect(r.mM).toBe(0);
  });
  it("does not delete unavailable rows",()=>{
    const plan=freezeAlphaPlan(fixturePopulation(),"p","V",2);
    expect(()=>a1Bound(plan,[1],[1])).toThrow(/COMPLETE_CASE/);
  });
  it("matches exact frozen margin arithmetic",()=>{
    const m=a1Margins(30,10,1,7,.021);
    expect(m.mM).toBe(Math.sqrt(Math.log(1/.021)*7/200));
    expect(m.mS).toBe(2*Math.sqrt((1-9/30)*Math.log(1/(.05-.021))/20));
  });
  it("optimizes over the exact 49-point pre-Y grid",()=>{
    const p=fixturePopulation(),a=freezeAlphaPlan(p,"p","V",8);
    const margins=Array.from({length:49},(_,i)=>{const m=a1Margins(20,8,1,4,(i+1)/1000);return m.mM+m.mS;});
    expect(a.plannedMargin).toBeCloseTo(Math.min(...margins),14);
    expect(a.alphaM*1000).toBeCloseTo(Math.round(a.alphaM*1000));expect(a.alphaM+a.alphaS).toBe(.05);
  });
  it("sample identity, theta and technical outcome cannot alter frozen split",()=>{
    const p=fixturePopulation(),a=freezeAlphaPlan(p,"p","G",3);
    drawAuditSample(p,plans(p,3),"first");drawAuditSample(p,plans(p,3),"second");
    a1Bound(a,[.5,-.5,.5],[1,-1,null]);
    expect(freezeAlphaPlan(p,"p","G",3)).toEqual(a);
  });
  it("rejects missing selected references",()=>{
    const p=fixturePopulation(),a=plans(p,3),s=drawAuditSample(p,a,"x");
    expect(()=>inferA1(p,s,a,[])).toThrow(/REFERENCE_ID/);
  });
  it("rejects fabricated formal PASS objects",()=>{
    const fake={estimate:1,lowerConfidenceBound95:.9,pValueOneSided:.01,independentClusterCount:20};
    expect(()=>evaluateSealedTestGate({proposedV:fake,proposedG:fake,deltaV:fake})).toThrow(/PROVENANCE/);
  });
  it("bound V/G keep .05 each and support positive IUT",()=>{
    const report=fixtureReport(),v=a1ComponentTest(report,"p","V"),g=a1ComponentTest(report,"p","G");
    expect(evaluateCalCandidateIut({v,g,coverage:.5,minimumCoverage:.2,independentClusterSupport:40,minimumIndependentClusterSupport:5})).toMatchObject({status:"CAL_IUT_PASS",componentAlpha:.05});
  });
  it("rejects replacing G with V",()=>{
    const report=fixtureReport(),v=a1ComponentTest(report,"p","V");
    expect(()=>evaluateCalCandidateIut({v,g:v,coverage:.5,minimumCoverage:.2,independentClusterSupport:40,minimumIndependentClusterSupport:5})).toThrow(/PROVENANCE/);
  });
  it("rejects substituted sample Coverage",()=>{
    const report=fixtureReport();
    expect(()=>evaluateCalCandidateIut({v:a1ComponentTest(report,"p","V"),g:a1ComponentTest(report,"p","G"),coverage:1,
      minimumCoverage:.2,independentClusterSupport:40,minimumIndependentClusterSupport:5})).toThrow(/PROVENANCE/);
  });
});
describe("Planner V2 and A2 boundaries",()=>{
  it.each([.95,.90,.99] as const)("implements integer stress floor %s",r=>{
    for(let n=1;n<=300;n++)expect(unavailableStressCount(n,r)).toBe(Math.floor((100-Math.round(r*100))*n/100));
  });
  it("handles decimal .90 at n=10 exactly",()=>expect(unavailableStressCount(10,.90)).toBe(1));
  it("reports pending lawful inputs without invented N",()=>{
    expect(planMem2ScaleV2()).toMatchObject({FORMAL_NUMERIC_N:"PENDING_LAWFUL_PREY_INPUTS",A2_TRIGGER:"NOT_EVALUATED_PREY_INPUTS_ABSENT",PLANNING_ONLY:true,FORMAL_CONFIDENCE_EVIDENCE:false});
  });
  it("builds full DEV plus every component LOO",()=>{
    const dev=bindA1({purpose:"DEV" as const,fixed4:true as const,policyHashes:{p:H},rows:Array.from({length:4},(_,i)=>({componentId:`d${i}`,thetaHatFixed4:i<2?1:-1,decisions:{p:i<2}}))});
    expect(devPlanningWorlds(dev,"p")).toHaveLength(5);
  });
  it("fails closed on empty LOO support",()=>{
    const dev=bindA1({purpose:"DEV" as const,fixed4:true as const,policyHashes:{p:H},rows:[{componentId:"d1",thetaHatFixed4:1,decisions:{p:true}},{componentId:"d2",thetaHatFixed4:-1,decisions:{p:false}}]});
    expect(()=>devPlanningWorlds(dev,"p")).toThrow(/DEV_ROBUSTNESS_SUPPORT_INSUFFICIENT/);
  });
  it("fails closed at numerically ambiguous .80",()=>expect(classifyPlanningProbability(.79,.81)).toBe("PLANNING_PROBABILITY_NUMERICALLY_INDETERMINATE"));
  it("best-case exact enumeration is deterministic",()=>{
    const p=fixturePopulation();expect(minimumFeasibleProbability(p,"p",15,.95)).toEqual(minimumFeasibleProbability(p,"p",15,.95));
  });
  it("technical stress cannot improve LCB",()=>{
    const p=fixturePopulation(),a=freezeAlphaPlan(p,"p","V",20),w=Array(10).fill(1).concat(Array(10).fill(0)),d=w.map(v=>v?1:-1);
    expect(stressedBound(a,w,d,.90).lowerConfidenceBound95).toBeLessThanOrEqual(a1Bound(a,w,d).lowerConfidenceBound95);
  });
  it.each([["FEASIBLE","FORBIDDEN"],["INFEASIBLE","A2_ZERO_API_QUALIFICATION_ALLOWED"]])("A1 %s gives A2 %s",(minimumStatus,status)=>{
    expect(evaluateA2Trigger({preYInputsComplete:true,purpose:"CAL",auditDrawOccurred:false,targetCausalYRevealed:false,minimumStatus})).toBe(status);
  });
  it("A2 cannot evaluate before pre-Y freeze",()=>expect(evaluateA2Trigger({preYInputsComplete:false,purpose:"CAL",auditDrawOccurred:false,targetCausalYRevealed:false,minimumStatus:"INFEASIBLE"})).toBe("NOT_EVALUATED_PREY_INPUTS_ABSENT"));
  it("A2 cannot switch after draw or Y",()=>{
    expect(()=>evaluateA2Trigger({preYInputsComplete:true,purpose:"CAL",auditDrawOccurred:true,targetCausalYRevealed:false,minimumStatus:"INFEASIBLE"})).toThrow(/FORBIDDEN/);
  });
  it("TEST DeltaV cannot trigger A2",()=>expect(evaluateA2Trigger({preYInputsComplete:true,purpose:"SEALED_TEST",auditDrawOccurred:false,targetCausalYRevealed:false,minimumStatus:"INFEASIBLE"})).toBe("NOT_EVALUATED_PREY_INPUTS_ABSENT"));
  it("DEV planning simulation is deterministic with numerical uncertainty",()=>{
    const p=fixturePopulation(4,2),world={world:"DEV_FULL_WORLD",accept:[.8,1],reject:[-1,-.8]};
    const first=trainingProbability(p,"p",2,.95,world,1);
    expect(trainingProbability(p,"p",2,.95,world,1)).toEqual(first);expect(first.upper).toBeGreaterThan(first.lower);
  });
});

describe("DEV anchor and CAL sequence",()=>{
  const score=(coverage:number,n:number|null=10):CandidateScore=>({policy:{policyId:`p${coverage}`,policyHash:H,predictionVersion:"v1",threshold:coverage/100,targetCoverage:coverage},
    devV:.2,devG:.2,floorEligible:true,nRequiredDev:n,planningEvidenceHash:H});
  it("uses minimum n with higher coverage tie-break",()=>{
    const s=freezeCalSequence([score(20,15),score(30,10),score(40,10),score(60,12),score(100,1)],H);
    expect(s.anchorPolicyId).toBe("p40");expect(s.orderedPolicyIds).toEqual(["p40","p60"]);
  });
  it("100% is descriptive only",()=>expect(freezeCalSequence([score(100)],H).status).toBe("NO_CANDIDATE_READY_FOR_CAL"));
  it("no positive DEV G keeps CAL closed",()=>expect(freezeCalSequence([{...score(40),devG:0}],H).status).toBe("NO_CANDIDATE_READY_FOR_CAL"));
  it("deduplicates thresholds keeping highest target coverage",()=>{
    const a=score(20),b={...score(40),policy:{...score(40).policy,threshold:a.policy.threshold}};
    expect(freezeCalSequence([a,b],H).orderedPolicyIds).toEqual(["p40"]);
  });
  it("does not let floor-only failure stop a statistical sequence",()=>{
    const base=fixturePopulation(80,40);
    const policies=[{...base.policies[0],targetCoverage:40},{...base.policies[0],policyId:"q",threshold:.6,targetCoverage:60}];
    const p=freezePredictionPopulation({...base,policies,rows:base.rows.map((r,i)=>({...r,decisions:{p:i<40,q:i<48}}))});
    const report=fixtureReport(p);
    const scores=policies.map(policy=>({...score(policy.targetCoverage),policy}));
    scores[0].nRequiredDev=5;
    const sequence=freezeCalSequence(scores,H);
    const result=evaluateCalSequence(sequence,report,{minimumCoverage:.55,minimumAcceptedSupport:5});
    expect(result.reached).toHaveLength(2);expect(result.reached[0].statisticalPass).toBe(true);expect(result.reached[0].coveragePass).toBe(false);
    expect(result.selectedPolicyId).toBe("q");
  });
  it("rejects post-CAL reorder",()=>{
    const base=fixturePopulation(80,40);
    const policies=[base.policies[0],{...base.policies[0],policyId:"q",threshold:.6,targetCoverage:60}];
    const p=freezePredictionPopulation({...base,policies,rows:base.rows.map((r,i)=>({...r,decisions:{p:i<40,q:i<50}}))});
    const report=fixtureReport(p);
    const scores=policies.map(policy=>({...score(policy.targetCoverage),policy}));
    scores[0].nRequiredDev=5;
    const sequence=freezeCalSequence(scores,H);
    const changed=bindA1({...sequence,orderedPolicyIds:[...sequence.orderedPolicyIds].reverse()});
    expect(()=>evaluateCalSequence(changed,report,{minimumCoverage:.2,minimumAcceptedSupport:5})).toThrow();
  });
  it("stops at the first statistical failure",()=>{
    const base=fixturePopulation(2,1),policies=[base.policies[0],{...base.policies[0],policyId:"q",threshold:.6,targetCoverage:60}];
    const p=freezePredictionPopulation({...base,policies,rows:base.rows.map((r,i)=>({...r,decisions:{p:i<1,q:true}}))});
    const scores=policies.map(policy=>({...score(policy.targetCoverage),policy}));scores[0].nRequiredDev=5;
    const result=evaluateCalSequence(freezeCalSequence(scores,H),fixtureReport(p),{minimumCoverage:.2,minimumAcceptedSupport:1});
    expect(result.reached).toHaveLength(1);expect(result.reached[0].statisticalPass).toBe(false);expect(result.selectedPolicyId).toBeNull();
  });
  it("smoke rejects malformed authorization without a provider",()=>{
    expect(()=>assertSmokeAuthorization(bindA1({}) as any,{} as any)).toThrow();
  });
});
