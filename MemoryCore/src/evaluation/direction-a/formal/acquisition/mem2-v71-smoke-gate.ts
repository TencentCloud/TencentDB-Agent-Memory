import { assertA1Hash,assertPredictionPopulation,drawAuditSample,requireHash,type AlphaPlan,type AuditSample,
  type Bound,type PredictionPopulation } from "../analysis/mem2-a1.js";
import { FROZEN_DESIGN_BINDING } from "../config/frozen-design.js";

export interface SmokeAuthorizationBody {
  purpose:"MEM2_V7_1_MINIMUM_SMOKE"; authorizedBy:"RESEARCHER"; authorizedAt:string;
  snapshotHash:string; snapshotCommit:string; snapshotTree:string; populationHash:string; auditSampleHash:string;
  alphaPlanHashes:string[]; authorityBindingHash:string; profileHash:string; permissionLedgerHash:string;
  budgetLedgerHash:string; taskManifestHash:string; maximumCalls:number; maximumCostCny:number;
  provider:"deepseek";model:"deepseek-v4-pro";reasoningEffort:"low";maxOutputTokens:8192;timeoutMs:300000;
  sdkRetry:0;technicalRetry:0;smokeExcludedFromFormal:true;
}
export function assertSmokeAuthorization(auth:Bound<SmokeAuthorizationBody>,binding:{snapshotHash:string;snapshotCommit:string;
  snapshotTree:string;population:PredictionPopulation;sample:AuditSample;plans:AlphaPlan[];
  permissionLedgerHash:string;budgetLedgerHash:string;taskManifestHash:string}){
  assertA1Hash(auth);assertPredictionPopulation(binding.population);assertA1Hash(binding.sample);
  for(const h of [auth.snapshotHash,auth.authorityBindingHash,auth.profileHash,
    auth.permissionLedgerHash,auth.budgetLedgerHash,auth.taskManifestHash])requireHash(h);
  if(!/^[a-f0-9]{40}$/.test(auth.snapshotCommit)||!/^[a-f0-9]{40}$/.test(auth.snapshotTree))throw new Error("SMOKE_GIT_OBJECT_BINDING_INVALID");
  if(auth.purpose!=="MEM2_V7_1_MINIMUM_SMOKE"||auth.authorizedBy!=="RESEARCHER"||!Number.isFinite(Date.parse(auth.authorizedAt))
    ||auth.smokeExcludedFromFormal!==true||binding.population.purpose!=="SMOKE")throw new Error("RESEARCHER_AUTHORIZATION_REQUIRED_FOR_MINIMUM_SMOKE");
  if(auth.snapshotHash!==binding.snapshotHash||auth.snapshotCommit!==binding.snapshotCommit||auth.snapshotTree!==binding.snapshotTree
    ||auth.populationHash!==binding.population.contentHash||auth.auditSampleHash!==binding.sample.contentHash
    ||auth.authorityBindingHash!==FROZEN_DESIGN_BINDING.contentHash||auth.profileHash!==binding.population.profileHash
    ||auth.permissionLedgerHash!==binding.permissionLedgerHash||auth.budgetLedgerHash!==binding.budgetLedgerHash
    ||auth.taskManifestHash!==binding.taskManifestHash||binding.population.sourceSnapshotCodeHash!==binding.snapshotHash
    ||drawAuditSample(binding.population,binding.plans,binding.sample.seed).contentHash!==binding.sample.contentHash
    ||JSON.stringify([...auth.alphaPlanHashes].sort())!==JSON.stringify(binding.plans.map(p=>p.contentHash).sort()))
    throw new Error("SMOKE_EXACT_POST_SYNC_AUTHORIZATION_BINDING_MISMATCH");
  if(auth.provider!=="deepseek"||auth.model!=="deepseek-v4-pro"||auth.reasoningEffort!=="low"||auth.maxOutputTokens!==8192
    ||auth.timeoutMs!==300000||auth.sdkRetry!==0||auth.technicalRetry!==0||!Number.isSafeInteger(auth.maximumCalls)
    ||auth.maximumCalls!==binding.sample.n*10||!Number.isFinite(auth.maximumCostCny)||auth.maximumCostCny<=0||auth.maximumCostCny>30)
    throw new Error("SMOKE_PROFILE_OR_MAX5_BUDGET_DRIFT");
}
