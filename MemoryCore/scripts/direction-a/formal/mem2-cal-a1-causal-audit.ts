import {execFileSync} from "node:child_process";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {hashCanonical,sha256} from "../../../src/evaluation/direction-a/formal/core/canonical.js";
import {assertImmutableMem2PaidAuthorization,assertMem2CausalFrozenSampleBinding,assertMem2PaidAuthorizationRequest,type ImmutableMem2PaidAuthorization,
  type Mem2PaidAuthorizationRequest} from "../../../src/evaluation/direction-a/formal/acquisition/mem2-formal-stage-authorization.js";
import {authorizeMem2PaidExecution,createMem2ExecutorAfterAuthorization,loadDirectionASecretsAfterMem2Authorization}
  from "../../../src/evaluation/direction-a/formal/acquisition/mem2-formal-stage-gate.js";
import {assertMem2FormalBudgetLedgerState,Mem2FormalBudgetLedger,type Mem2FormalBudgetLedgerState}
  from "../../../src/evaluation/direction-a/formal/acquisition/mem2-formal-budget.js";
import {runMem2FormalGroups} from "../../../src/evaluation/direction-a/formal/acquisition/mem2-formal-train-dev-runner.js";
import {assertCommittedGitSourceBinding,GIT_COMMITTED_BLOB_BYTES}
  from "../../../src/evaluation/direction-a/formal/acquisition/mem2-git-source-binding.js";
import {AuthorizedMem2StandaloneExecutor} from "../../../src/evaluation/direction-a/formal/executors/authorized-mem2-standalone-executor.js";
import type {OnlineMem2ActTask} from "../../../src/evaluation/direction-a/online-like.js";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../..");
const executePaid=process.argv.includes("--execute-paid"),dryRun=process.argv.includes("--dry-run");
if(executePaid===dryRun)throw new Error("EXACTLY_ONE_OF_DRY_RUN_OR_EXECUTE_PAID_REQUIRED");
const value=(name:string)=>{const i=process.argv.indexOf(name);if(i<0||!process.argv[i+1])throw new Error(`REQUIRED:${name}`);return process.argv[i+1];};
const file=(name:string)=>path.resolve(value(name));
const read=async<T=any>(p:string)=>JSON.parse(await readFile(p,"utf8")) as T;
const bound=(v:any,label:string)=>{const {contentHash,...body}=v;if(hashCanonical(body)!==contentHash)throw new Error(`${label}_CONTENT_HASH_MISMATCH`);return v;};
const request=await read<Mem2PaidAuthorizationRequest>(file("--authorization-request"));assertMem2PaidAuthorizationRequest(request);
if(request.purpose!=="MEM2_CAL_A1_CAUSAL_AUDIT")throw new Error("MEM2_CAL_A1_CAUSAL_PURPOSE_REQUIRED");
const sample=bound(await read(file("--sample")),"SAMPLE"),alpha=bound(await read(file("--alpha-plans")),"ALPHA"),
  budget=bound(await read(file("--budget-forecast")),"BUDGET"),snapshot=bound(await read(file("--snapshot-manifest")),"SNAPSHOT"),
  packageManifest=bound(await read(file("--package-manifest")),"PACKAGE"),sourceBinding=bound(await read(file("--source-binding-manifest")),"SOURCE_BINDING"),
  partitions=bound(await read(file("--partition-manifest")),"PARTITIONS"),
  tasks=bound(await read(file("--task-manifest")),"TASKS"),cheap=bound(await read(file("--cheap-x-freeze")),"CHEAP_X");
const ledgerPath=file("--budget-ledger"),ledger=await read<Mem2FormalBudgetLedgerState>(ledgerPath);assertMem2FormalBudgetLedgerState(ledger);
const amendmentSha=sha256(await readFile(file("--amendment")));
const selectedIds:string[]=sample.selectedComponentIds,selectedSet=new Set(selectedIds);
assertMem2CausalFrozenSampleBinding({request,sample});
const selectedTasks:OnlineMem2ActTask[]=tasks.tasks.filter((task:OnlineMem2ActTask)=>selectedSet.has(task.componentId));
const calIds=new Set(partitions.partitions.PROTECTED_CAL.map((row:any)=>row.componentId));
const forbiddenIds=new Set(["TRAIN","DEV","PROTECTED_SEALED_TEST"].flatMap(key=>partitions.partitions[key].map((row:any)=>row.componentId)));
const normalRows=cheap.rows.filter((row:any)=>selectedSet.has(row.componentId));
const sourceFiles:Record<string,{path:string;sha:string|undefined}>={
  formalAdapter:{path:"src/evaluation/direction-a/formal/executors/mem2-standalone-call.ts",sha:request.formalAdapterSourceHash},
  runner:{path:"src/evaluation/direction-a/formal/acquisition/mem2-formal-train-dev-runner.ts",sha:request.runnerSourceHash},
  stageCli:{path:"scripts/direction-a/formal/mem2-cal-a1-causal-audit.ts",sha:request.stageCliSourceHash},
  authorizationMaterializer:{path:"scripts/direction-a/formal/mem2-cal-a1-causal-authorize.ts",sha:request.authorizationMaterializerSourceHash},
  authorization:{path:"src/evaluation/direction-a/formal/acquisition/mem2-formal-stage-authorization.ts",sha:request.paidSupportSourceHashes?.authorization},
  gate:{path:"src/evaluation/direction-a/formal/acquisition/mem2-formal-stage-gate.ts",sha:request.paidSupportSourceHashes?.gate},
  budget:{path:"src/evaluation/direction-a/formal/acquisition/mem2-formal-budget.ts",sha:request.paidSupportSourceHashes?.budget},
};
if(selectedIds.some(id=>!calIds.has(id)||forbiddenIds.has(id))||selectedTasks.length!==selectedIds.length||normalRows.length!==selectedIds.length
  ||alpha.alphaPlanHashes.length!==request.alphaPlanHashes?.length||alpha.alphaPlanHashes.some((h:string)=>!request.alphaPlanHashes?.includes(h))
  ||budget.contentHash!==request.budgetForecastHash||snapshot.contentHash!==request.candidateSnapshotHash
  ||packageManifest.contentHash!==request.candidatePackageHash||sourceBinding.contentHash!==request.sourceBindingManifestHash
  ||sourceBinding.hashScope!==GIT_COMMITTED_BLOB_BYTES||sourceBinding.commit!==request.candidateCommit||sourceBinding.tree!==request.candidateTree
  ||request.sourceHashScope!==GIT_COMMITTED_BLOB_BYTES||partitions.partitionHashes.PROTECTED_CAL!==request.protectedCalPartitionHash
  ||tasks.contentHash!==request.taskSourceManifestHash||amendmentSha!==request.a1BudgetExtensionAmendmentSha256
  ||request.maximumNormalCalls!==0||request.maximumFullRemoveCalls!==10*selectedIds.length
  ||request.maximumProviderCalls!==request.maximumFullRemoveCalls||request.technicalRetry!==0||request.noSampleRedraw!==true)
  throw new Error("MEM2_CAL_A1_CAUSAL_PREFLIGHT_BINDING_DRIFT");
for(const [label,boundSource] of Object.entries(sourceFiles)){
  if(!boundSource.sha)throw new Error(`MEM2_CAL_A1_CAUSAL_SOURCE_HASH_MISSING:${label}`);
  const manifestBinding=sourceBinding.sources?.[boundSource.path];
  if(!manifestBinding||manifestBinding.gitBlobSha256!==boundSource.sha)throw new Error(`MEM2_CAL_A1_CAUSAL_SOURCE_MANIFEST_DRIFT:${label}`);
  assertCommittedGitSourceBinding({workingDirectory:root,sourcePath:boundSource.path,expectedCommit:request.candidateCommit,
    expectedTree:request.candidateTree,expectedSha256:boundSource.sha,expectedGitBlobOid:manifestBinding.gitBlobOid});
}
if(dryRun){if(ledger.contentHash!==request.budgetLedgerCurrentHash)throw new Error("MEM2_CAL_A1_DRY_RUN_LEDGER_DRIFT");
  console.log(JSON.stringify({status:"MEM2_CAL_A1_CAUSAL_ZERO_PROVIDER_DRY_RUN_PASS",sampleHash:sample.contentHash,
    groups:selectedIds.length,maximumNormalCalls:0,maximumFullRemoveCalls:request.maximumFullRemoveCalls,
    maximumProviderCalls:request.maximumProviderCalls,technicalRetryLimit:0,providerCalls:0,secretReads:0,calCausalY:0,testCausalY:0},null,2));process.exit(0);}

const authorization=await read<ImmutableMem2PaidAuthorization>(file("--authorization"));assertImmutableMem2PaidAuthorization(authorization,request);
const output=file("--output");
if(output!==path.resolve(request.outputRoot)||path.resolve(request.journalRoot)!==output||path.resolve(request.rawArtifactRoot)!==output)
  throw new Error("MEM2_CAL_A1_RUNTIME_ROOT_DRIFT");
if(ledger.schemaVersion!=="direction-a.mem2-source.global-budget.v5"||ledger.predecessorStateHash!==request.budgetLedgerCurrentHash
  ||ledger.hardCapCny!==request.hardCapCny||ledger.a1BudgetExtensionAmendmentSha256!==request.a1BudgetExtensionAmendmentSha256)
  throw new Error("MEM2_CAL_A1_EXTENDED_LEDGER_REQUIRED");
const git=(args:string[])=>execFileSync("git",args,{cwd:root,encoding:"utf8",windowsHide:true}).trim();
const dirty=git(["status","--porcelain=v1","--untracked-files=all"]).split(/\r?\n/).filter(Boolean)
  .filter(line=>!/^\?\? (?:MemoryCore\/)?\.workbuddy\//.test(line));
if(dirty.length)throw new Error("MEM2_CAL_A1_EXECUTION_REQUIRES_EXACT_CLEAN_TREE");
const partitionBindingHash=hashCanonical({freshPopulationRegistryHash:request.freshPopulationRegistryHash,
  formalExclusionRegistryHash:request.formalExclusionRegistryHash,trainPartitionHash:request.trainPartitionHash,
  devPartitionHash:request.devPartitionHash,protectedCalPartitionHash:request.protectedCalPartitionHash,
  protectedSealedTestPartitionHash:request.protectedSealedTestPartitionHash});
const permit=authorizeMem2PaidExecution({request,authorization,liveCommit:git(["rev-parse","HEAD"]),
  liveTree:git(["rev-parse","HEAD^{tree}"]),liveBranch:git(["branch","--show-current"]),snapshotHash:snapshot.contentHash,
  authorityBindingHash:request.authorityBindingHash,verifierHash:request.verifierHash,profileHash:request.profileHash,
  protocolHash:request.protocolHash,partitionBindingHash,budgetLedgerHash:ledger.contentHash,
  budgetLedgerPredecessorHash:request.budgetLedgerPredecessorHash,state:{providerCalls:0,modelCalls:0,normalCalls:0,
    fullCalls:0,removeCalls:0,formalTrainDevCalls:0,calCausalY:0,sealedTestCausalY:0,secretReadEvents:0}});
const ledgerApi=new Mem2FormalBudgetLedger(ledgerPath);
const reservationId=await ledgerApi.reserve({workerId:"mem2-cal-a1-causal-audit",unitId:authorization.contentHash,
  amountCny:request.maximumCostCny,authorizationHash:authorization.contentHash,phase:"MEM2_CAL_A1_CAUSAL_AUDIT"});
const secrets=await loadDirectionASecretsAfterMem2Authorization(file("--secret-env"),permit);
const {StandaloneLLMRunner}=await import("../../../src/adapters/standalone/llm-runner.js");
const apiKey=secrets.DIRECTION_A_API_KEY??secrets.DEEPSEEK_API_KEY;
const baseUrl=secrets.DIRECTION_A_BASE_URL??secrets.DEEPSEEK_BASE_URL??"https://api.deepseek.com/v1";
if(!apiKey||new URL(baseUrl).origin!=="https://api.deepseek.com")throw new Error("AUTHORIZED_DIRECTION_A_SECRET_OR_PROVIDER_INVALID");
const executor=createMem2ExecutorAfterAuthorization(permit,()=>new AuthorizedMem2StandaloneExecutor({permit,tasks:selectedTasks,
  outputRoot:output,inputPricePerMillionCny:tasks.inputPricePerMillionCny,outputPricePerMillionCny:tasks.outputPricePerMillionCny,
  providerFactory:()=>new StandaloneLLMRunner({config:{baseUrl,apiKey,model:"deepseek-v4-pro",maxTokens:8192,timeoutMs:300000,
    sdkMaxRetries:0,reasoningEffort:"low"},model:"deepseek-v4-pro",enableTools:false})}));
const results=await runMem2FormalGroups({permit,executor,tasks:selectedTasks,outputRoot:output,
  authorityBindingHash:request.authorityBindingHash,verifierHash:request.verifierHash,
  maximumProviderCalls:request.maximumProviderCalls,maximumCostCny:request.maximumCostCny,
  reusedNormalArtifacts:normalRows.map((row:any)=>({componentId:row.componentId,attemptId:row.attemptId,rawArtifactHash:row.rawArtifactHash}))});
const calls=results.reduce((sum,row)=>sum+row.providerCalls,0),cost=results.reduce((sum,row)=>sum+row.observedUsageCostCny,0),
  unknown=results.reduce((sum,row)=>sum+row.unknownUsageCalls,0);
await ledgerApi.reconcile({reservationId,observedUsageCostCny:cost,paidLogicalCalls:calls,unknownUsageCalls:unknown});
console.log(JSON.stringify({status:"MEM2_CAL_A1_CAUSAL_ACQUISITION_COMPLETE_STOP_FOR_CODEX_INTEGRITY_AUDIT",
  groups:results.length,normalCalls:0,fullRemoveCalls:calls,providerCalls:calls,observedUsageCostCny:cost,
  unknownUsageCalls:unknown,calCausalY:results.length,testCausalY:0,results},null,2));
