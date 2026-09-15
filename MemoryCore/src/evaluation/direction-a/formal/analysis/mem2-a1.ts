import { hashCanonical, immutableCopy, sha256 } from "../core/canonical.js";
import { FROZEN_DESIGN_BINDING } from "../config/frozen-design.js";
import { assertMem2ContinuousReferenceArtifact, type Mem2ContinuousReferenceArtifact } from "../teacher/mem2-continuous-reference.js";

export const A1_VERSION = "MEM2-A1-SRSWOR-TWO-LAYER-INFERENCE-V1-2026-09-09";
export type A1Metric = "V" | "G" | "DeltaV";
export type Bound<T> = Readonly<T & { contentHash: string }>;
export function bindA1<T extends object>(body: T): Bound<T> {
  const {contentHash: _oldHash,...payload}=body as T & {contentHash?:string};
  return immutableCopy({ ...payload, contentHash: hashCanonical(payload) }) as Bound<T>;
}
export function assertA1Hash(value: { contentHash: string }): void {
  const { contentHash, ...body } = value;
  if (hashCanonical(body) !== contentHash) throw new Error("A1_CONTENT_HASH_MISMATCH");
}
export function requireHash(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("A1_SHA256_REQUIRED");
}
export interface PredictionRow {
  componentId: string;
  statisticalClusterId: string;
  decisions: Record<string, boolean>;
  baselineAccepted: boolean;
}
export interface Policy {
  policyId: string;
  predictionVersion: string;
  policyHash: string;
  threshold: number;
  targetCoverage: number;
}
export interface PopulationInput {
  purpose: "CAL" | "SEALED_TEST" | "SMOKE";
  environment: "Mem2";
  rows: PredictionRow[];
  policies: Policy[];
  completeQualifiedPartitionHash: string;
  authorityHashes: Record<string, string>;
  frozenDesignBindingHash: string;
  sourceSnapshotCodeHash: string;
  profileHash: string;
  protocolHash: string;
  verifierHash: string;
  cheapXFreezeHash: string;
  preY: true;
}
export type PredictionPopulation = Bound<PopulationInput & {
  schemaVersion: "FROZEN_PREDICTION_POPULATION_MANIFEST.v1";
  N: number;
  coverage: Record<string, number>;
  baselineCoverage: number;
}>;
export function freezePredictionPopulation(input: PopulationInput): PredictionPopulation {
  const allowed=["purpose","environment","rows","policies","completeQualifiedPartitionHash","authorityHashes","frozenDesignBindingHash",
    "sourceSnapshotCodeHash","profileHash","protocolHash","verifierHash","cheapXFreezeHash","preY","contentHash","schemaVersion","N","coverage","baselineCoverage"];
  if(Object.keys(input).some(k=>!allowed.includes(k)))throw new Error("A1_UNDECLARED_OR_Y_POPULATION_INPUT_FORBIDDEN");
  if (input.environment !== "Mem2" || !["CAL", "SEALED_TEST", "SMOKE"].includes(input.purpose) || input.preY !== true)
    throw new Error("A1_POPULATION_PURPOSE_OR_PREY_INVALID");
  if (!input.rows.length || !input.policies.length) throw new Error("A1_COMPLETE_POPULATION_REQUIRED");
  for (const value of [input.completeQualifiedPartitionHash, input.sourceSnapshotCodeHash, input.profileHash,
    input.protocolHash, input.verifierHash, input.cheapXFreezeHash, ...Object.values(input.authorityHashes)]) requireHash(value);
  if (!Object.keys(input.authorityHashes).length || input.frozenDesignBindingHash !== FROZEN_DESIGN_BINDING.contentHash)
    throw new Error("A1_CURRENT_AUTHORITY_BINDING_REQUIRED");
  const policyIds = input.policies.map(p => p.policyId);
  if (new Set(policyIds).size !== policyIds.length) throw new Error("A1_DUPLICATE_POLICY");
  for (const policy of input.policies) {
    requireHash(policy.policyHash);
    if (!policy.policyId || !policy.predictionVersion || !Number.isFinite(policy.threshold)
      || ![20,30,40,50,60,70,80,90,100].includes(policy.targetCoverage)) throw new Error("A1_POLICY_INVALID");
  }
  const rows = [...input.rows].sort((a,b) => a.componentId.localeCompare(b.componentId, "en"));
  for (const row of rows) {
    if(Object.keys(row).some(k=>!["componentId","statisticalClusterId","decisions","baselineAccepted"].includes(k)))throw new Error("A1_PREDICTIONS_MUST_BE_PREY_ONLY");
    if (!row.componentId || !row.statisticalClusterId || typeof row.baselineAccepted !== "boolean"
      || hashCanonical(Object.keys(row.decisions).sort()) !== hashCanonical([...policyIds].sort())
      || Object.values(row.decisions).some(a => typeof a !== "boolean")) throw new Error("A1_PREDICTION_ROW_INVALID");
  }
  if (new Set(rows.map(r => r.componentId)).size !== rows.length
    || new Set(rows.map(r => r.statisticalClusterId)).size !== rows.length) throw new Error("A1_DUPLICATE_COMPONENT_OR_CLUSTER");
  // The partition hash is an independently frozen exhaustive identity list, not a sample hash.
  if (hashCanonical(rows.map(r => ({ componentId: r.componentId, statisticalClusterId: r.statisticalClusterId })))
    !== input.completeQualifiedPartitionHash) throw new Error("A1_MISSING_OR_EXTRA_POPULATION_IDS");
  return bindA1({ ...input, rows, schemaVersion: "FROZEN_PREDICTION_POPULATION_MANIFEST.v1" as const,
    N: rows.length, coverage: Object.fromEntries(policyIds.map(id => [id, rows.filter(r => r.decisions[id]).length / rows.length])),
    baselineCoverage: rows.filter(r => r.baselineAccepted).length / rows.length });
}
export function assertPredictionPopulation(p: PredictionPopulation): void {
  assertA1Hash(p);
  const { contentHash, schemaVersion, N, coverage, baselineCoverage, ...input } = p;
  if (freezePredictionPopulation(input).contentHash !== contentHash) throw new Error("A1_POPULATION_DERIVATION_MISMATCH");
}
export function populationWeights(p: PredictionPopulation, policyId: string, metric: A1Metric): number[] {
  if (!p.policies.some(q => q.policyId === policyId) || !["V","G","DeltaV"].includes(metric)) throw new Error("A1_UNKNOWN_POLICY_OR_METRIC");
  return p.rows.map(r => Number(r.decisions[policyId]) - (metric === "G" ? p.coverage[policyId] : metric === "DeltaV" ? Number(r.baselineAccepted) : 0));
}
export function a1Rho(N: number, n: number): number {
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(n) || n < 1 || n > N) throw new Error("A1_INVALID_N_N");
  return n <= N / 2 ? 1 - (n-1)/N : (1-n/N)*(1+1/n);
}
export function a1Margins(N: number, n: number, B: number, sumAvailableW2: number, alphaM: number) {
  const rho = a1Rho(N,n);
  if (!Number.isFinite(B) || B < 0 || B > 1 || !Number.isFinite(sumAvailableW2) || sumAvailableW2 < 0
    || sumAvailableW2 > n + 1e-12 || alphaM < .001 || alphaM > .049) throw new Error("A1_MARGIN_INPUT_INVALID");
  const alphaS = .05-alphaM;
  return { mM: Math.sqrt(Math.log(1/alphaM)*sumAvailableW2/(2*n*n)),
    mS: 2*B*Math.sqrt(rho*Math.log(1/alphaS)/(2*n)), rho, alphaM, alphaS };
}
export type AlphaPlan = Bound<{ schemaVersion: "A1_INFERENCE_MANIFEST.v1"; a1Version: typeof A1_VERSION;
  populationHash: string; policyId: string; policyHash: string; metric: A1Metric; n: number; N: number;
  B: number; plannedSumW2: number; alphaM: number; alphaS: number; plannedMargin: number;
  frozenBeforeSampleDraw: true; gridVersion: "001_TO_049_TIE_025_THEN_SMALLER.v1" }>;
export function freezeAlphaPlan(p: PredictionPopulation, policyId: string, metric: A1Metric, n: number): AlphaPlan {
  assertPredictionPopulation(p);
  a1Rho(p.N,n);
  const w = populationWeights(p,policyId,metric);
  const B = Math.max(...w.map(Math.abs));
  const plannedSumW2 = n*w.reduce((s,v) => s+v*v,0)/p.N;
  const grid = Array.from({length:49},(_,i) => {
    const alphaM=(i+1)/1000;
    const m=a1Margins(p.N,n,B,plannedSumW2,alphaM);
    return { alphaM, alphaS:m.alphaS, plannedMargin:m.mM+m.mS };
  });
  grid.sort((a,b) => Math.abs(a.plannedMargin-b.plannedMargin)>1e-14 ? a.plannedMargin-b.plannedMargin
    : Math.abs(a.alphaM-.025)-Math.abs(b.alphaM-.025) || a.alphaM-b.alphaM);
  return bindA1({ schemaVersion:"A1_INFERENCE_MANIFEST.v1", a1Version:A1_VERSION,
    populationHash:p.contentHash, policyId, policyHash:p.policies.find(q=>q.policyId===policyId)!.policyHash,
    metric,n,N:p.N,B,plannedSumW2,...grid[0],frozenBeforeSampleDraw:true,
    gridVersion:"001_TO_049_TIE_025_THEN_SMALLER.v1" });
}
/** SHA256 counter stream with rejection sampling; no modulo bias in Fisher-Yates. */
export function a1Random(seed: string): (limit: number) => number {
  let counter=0;
  return limit => {
    if (!Number.isSafeInteger(limit) || limit<1 || limit>0x100000000) throw new Error("A1_PRNG_LIMIT_INVALID");
    const ceiling=Math.floor(0x100000000/limit)*limit;
    for (;;) {
      const x=Number.parseInt(sha256(`${seed}:${counter++}`).slice(0,8),16);
      if (x<ceiling) return x%limit;
    }
  };
}
export function srsworIndices(N: number,n: number,random: (limit:number)=>number): number[] {
  a1Rho(N,n);
  const ids=Array.from({length:N},(_,i)=>i);
  for (let i=0;i<n;i++) { const j=i+random(N-i); [ids[i],ids[j]]=[ids[j],ids[i]]; }
  return ids.slice(0,n);
}
export type AuditSample = Bound<{ schemaVersion:"FROZEN_CAUSAL_AUDIT_SAMPLE_MANIFEST.v1";
  populationHash:string; alphaPlanHashes:string[]; seed:string; samplingVersion:"SHA256_REJECTION_FISHER_YATES.v1";
  n:number; selectedIds:string[]; purpose:PopulationInput["purpose"]; allSelectedRunFixed4:true }>;
export function drawAuditSample(p:PredictionPopulation, plans: readonly AlphaPlan[], seed:string): AuditSample {
  assertPredictionPopulation(p);
  if (!seed || !plans.length) throw new Error("A1_PRE_SAMPLING_PLANS_REQUIRED");
  const n=plans[0].n;
  const expected=p.policies.flatMap(q => ["V","G","DeltaV"].map(metric => `${q.policyId}:${metric}`)).sort();
  if (hashCanonical(plans.map(q=>`${q.policyId}:${q.metric}`).sort())!==hashCanonical(expected)) throw new Error("A1_ALL_POLICY_METRIC_SPLITS_REQUIRED");
  for (const plan of plans) {
    assertA1Hash(plan);
    if (plan.n!==n || freezeAlphaPlan(p,plan.policyId,plan.metric,n).contentHash!==plan.contentHash)
      throw new Error("A1_ALPHA_PLAN_BINDING_MISMATCH");
  }
  // Decisions and alpha optimization do not enter the random stream.
  const selectedIds=srsworIndices(p.N,n,a1Random(seed)).map(i=>p.rows[i].componentId);
  return bindA1({schemaVersion:"FROZEN_CAUSAL_AUDIT_SAMPLE_MANIFEST.v1",populationHash:p.contentHash,
    alphaPlanHashes:plans.map(q=>q.contentHash).sort(),seed,samplingVersion:"SHA256_REJECTION_FISHER_YATES.v1",
    n,selectedIds,purpose:p.purpose,allSelectedRunFixed4:true});
}

export type CalA1AuditSample = Bound<{schemaVersion:"CAL_A1_SRSWOR_SAMPLE_MANIFEST.v1";
  populationHash:string; N:number; n:number; selectedIds:string[]; finalPolicyIds:string[];
  alphaPlanHashes:string[]; seed:string; seedHash:string;
  samplingVersion:"SHA256_REJECTION_FISHER_YATES.v1"; inclusionRule:"FIXED_SIZE_COMPONENT_SRSWOR";
  purpose:"CAL"; sampleDrawn:true; calCausalY:0; testCausalY:0}>;

/** Current CAL A1 draw: the already-qualified rejection-sampled Fisher-Yates
 * implementation, restricted to the frozen formal sequence and its V/G plans. */
export function drawCalA1AuditSample(p:PredictionPopulation,plans:readonly AlphaPlan[],
  finalPolicyIds:readonly string[],seed:string):CalA1AuditSample {
  assertPredictionPopulation(p);
  if(p.purpose!=="CAL"||!seed||!plans.length||!finalPolicyIds.length
    ||new Set(finalPolicyIds).size!==finalPolicyIds.length)throw new Error("CAL_A1_PRE_DRAW_BINDING_REQUIRED");
  const known=new Set(p.policies.map(row=>row.policyId));
  if(finalPolicyIds.some(id=>!known.has(id)))throw new Error("CAL_A1_UNKNOWN_FORMAL_POLICY");
  const n=plans[0].n;
  const expected=finalPolicyIds.flatMap(id=>["V","G"].map(metric=>`${id}:${metric}`)).sort();
  if(hashCanonical(plans.map(row=>`${row.policyId}:${row.metric}`).sort())!==hashCanonical(expected))
    throw new Error("CAL_A1_EXACT_V_G_ALPHA_PLANS_REQUIRED");
  for(const plan of plans){assertA1Hash(plan);if(plan.n!==n||freezeAlphaPlan(p,plan.policyId,plan.metric,n).contentHash!==plan.contentHash)
    throw new Error("CAL_A1_ALPHA_PLAN_BINDING_MISMATCH");}
  const selectedIds=srsworIndices(p.N,n,a1Random(seed)).map(i=>p.rows[i].componentId);
  return bindA1({schemaVersion:"CAL_A1_SRSWOR_SAMPLE_MANIFEST.v1",populationHash:p.contentHash,N:p.N,n,selectedIds,
    finalPolicyIds:[...finalPolicyIds],alphaPlanHashes:plans.map(row=>row.contentHash).sort(),seed,seedHash:sha256(seed),
    samplingVersion:"SHA256_REJECTION_FISHER_YATES.v1",inclusionRule:"FIXED_SIZE_COMPONENT_SRSWOR",
    purpose:"CAL",sampleDrawn:true,calCausalY:0,testCausalY:0});
}
export function auditReferenceStatus(sample:AuditSample,id:string): "SELECTED_REFERENCE_PENDING"|"NOT_SELECTED_FOR_CAUSAL_AUDIT" {
  assertA1Hash(sample);
  return sample.selectedIds.includes(id)?"SELECTED_REFERENCE_PENDING":"NOT_SELECTED_FOR_CAUSAL_AUDIT";
}
export interface A1NumericalResult { estimate:number; lowerConfidenceBound95:number; mM:number; mS:number; availableCount:number; unavailableCount:number; componentAlpha:0.05; pass:boolean }
/** Shared exact kernel for formal reports and explicitly non-formal planning worlds. */
export function a1Bound(plan:AlphaPlan, weights:readonly number[], effects:readonly (number|null)[]): A1NumericalResult {
  if (weights.length!==plan.n || effects.length!==plan.n) throw new Error("A1_NO_COMPLETE_CASE_DELETION");
  let sum=0,w2=0,availableCount=0;
  weights.forEach((w,i)=>{
    const d=effects[i];
    if (!Number.isFinite(w) || Math.abs(w)>plan.B+1e-12 || (d!==null && (!Number.isFinite(d)||Math.abs(d)>1))) throw new Error("A1_BOUNDED_INPUT_INVALID");
    sum+=d===null?-Math.abs(w):w*d;
    if(d!==null){w2+=w*w;availableCount++;}
  });
  const {mM,mS}=a1Margins(plan.N,plan.n,plan.B,w2,plan.alphaM);
  const estimate=sum/plan.n,lowerConfidenceBound95=estimate-mM-mS;
  return {estimate,lowerConfidenceBound95,mM,mS,availableCount,unavailableCount:plan.n-availableCount,componentAlpha:.05,pass:lowerConfidenceBound95>0};
}
export type A1Report = Bound<{schemaVersion:"A1_INFERENCE_REPORT.v1"; a1Version:typeof A1_VERSION;
  population:PredictionPopulation; sample:AuditSample; plans:AlphaPlan[]; references:Mem2ContinuousReferenceArtifact[];
  tests:Record<string,Record<A1Metric,A1NumericalResult>>; formalConfidenceEvidence:boolean}>;
export function inferA1(p:PredictionPopulation,sample:AuditSample,plans:AlphaPlan[],references:Mem2ContinuousReferenceArtifact[]):A1Report {
  assertA1Hash(sample);
  if(drawAuditSample(p,plans,sample.seed).contentHash!==sample.contentHash) throw new Error("A1_SAMPLE_PROVENANCE_MISMATCH");
  if(hashCanonical(references.map(r=>r.causalGroupId).sort())!==hashCanonical([...sample.selectedIds].sort())) throw new Error("A1_REFERENCE_ID_SET_MISMATCH");
  for(const ref of references){
    assertMem2ContinuousReferenceArtifact(ref);
    const row=p.rows.find(r=>r.componentId===ref.causalGroupId)!;
    if(ref.statisticalClusterId!==row.statisticalClusterId || ref.bindings.authorityBindingHash!==p.frozenDesignBindingHash
      || ref.bindings.snapshotHash!==p.sourceSnapshotCodeHash || ref.bindings.profileHash!==p.profileHash
      || ref.bindings.protocolHash!==p.protocolHash || ref.bindings.verifierHash!==p.verifierHash)
      throw new Error("A1_REFERENCE_BINDING_MISMATCH");
  }
  const indices=sample.selectedIds.map(id=>p.rows.findIndex(r=>r.componentId===id));
  const effects=sample.selectedIds.map(id=>references.find(r=>r.causalGroupId===id)!.thetaHatFixed4);
  const tests:Record<string,Record<A1Metric,A1NumericalResult>>={};
  for(const policy of p.policies){
    tests[policy.policyId]={} as Record<A1Metric,A1NumericalResult>;
    for(const metric of ["V","G","DeltaV"] as const){
      const w=populationWeights(p,policy.policyId,metric);
      tests[policy.policyId][metric]=a1Bound(plans.find(q=>q.policyId===policy.policyId&&q.metric===metric)!,indices.map(i=>w[i]),effects);
    }
  }
  return bindA1({schemaVersion:"A1_INFERENCE_REPORT.v1",a1Version:A1_VERSION,population:p,sample,plans,references,tests,formalConfidenceEvidence:p.purpose!=="SMOKE"});
}
export function assertA1Report(report:A1Report):void {
  assertA1Hash(report);
  if(inferA1(report.population,report.sample,report.plans,report.references).contentHash!==report.contentHash) throw new Error("A1_REPORT_DERIVATION_MISMATCH");
}
