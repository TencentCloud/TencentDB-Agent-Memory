import {mkdir,readFile,writeFile} from "node:fs/promises";
import path from "node:path";
import {hashCanonical,sha256} from "../../../src/evaluation/direction-a/formal/core/canonical.js";
import {assertImmutableMem2PaidAuthorization,assertMem2PaidAuthorizationRequest,
  materializeImmutableMem2PaidAuthorization,type Mem2PaidAuthorizationRequest}
  from "../../../src/evaluation/direction-a/formal/acquisition/mem2-formal-stage-authorization.js";
import {assertMem2FormalBudgetLedgerState,buildA1ExtendedBudgetLedger,type Mem2FormalBudgetLedgerState}
  from "../../../src/evaluation/direction-a/formal/acquisition/mem2-formal-budget.js";

const value=(name:string)=>{const i=process.argv.indexOf(name);if(i<0||!process.argv[i+1])throw new Error(`REQUIRED:${name}`);return process.argv[i+1];};
const file=(name:string)=>path.resolve(value(name));
const read=async<T=any>(p:string)=>JSON.parse(await readFile(p,"utf8")) as T;
const bound=(v:any,label:string)=>{const {contentHash,...body}=v;if(hashCanonical(body)!==contentHash)throw new Error(`${label}_CONTENT_HASH_MISMATCH`);return v;};
const request=await read<Mem2PaidAuthorizationRequest>(file("--authorization-request"));
assertMem2PaidAuthorizationRequest(request);
if(request.purpose!=="MEM2_CAL_A1_CAUSAL_AUDIT")throw new Error("MEM2_CAL_A1_CAUSAL_PURPOSE_REQUIRED");
const sample=bound(await read(file("--sample")),"SAMPLE"),alpha=bound(await read(file("--alpha-plans")),"ALPHA"),
  budget=bound(await read(file("--budget-forecast")),"BUDGET"),snapshot=bound(await read(file("--snapshot-manifest")),"SNAPSHOT"),
  packageManifest=bound(await read(file("--package-manifest")),"PACKAGE"),
  sourceBinding=bound(await read(file("--source-binding-manifest")),"SOURCE_BINDING"),
  ledger=await read<Mem2FormalBudgetLedgerState>(file("--budget-ledger"));
assertMem2FormalBudgetLedgerState(ledger);
const amendmentSha=sha256(await readFile(file("--amendment")));
if(sample.contentHash!==request.sampleManifestHash||alpha.alphaPlanHashes.some((h:string)=>!request.alphaPlanHashes?.includes(h))
  ||alpha.alphaPlanHashes.length!==request.alphaPlanHashes?.length||budget.contentHash!==request.budgetForecastHash
  ||snapshot.contentHash!==request.candidateSnapshotHash||packageManifest.contentHash!==request.candidatePackageHash
  ||sourceBinding.contentHash!==request.sourceBindingManifestHash||sourceBinding.hashScope!==request.sourceHashScope
  ||ledger.contentHash!==request.budgetLedgerCurrentHash||amendmentSha!==request.a1BudgetExtensionAmendmentSha256
  ||sample.n!==request.formalCalAuditN||hashCanonical(sample.selectedComponentIds)!==hashCanonical(request.allowedStageGroups)
  ||budget.effectiveHardCapCny!==request.hardCapCny||budget.protectedTotalCny!==request.hardCapCny)
  throw new Error("MEM2_CAL_A1_AUTHORIZATION_BINDING_DRIFT");
const authorization=materializeImmutableMem2PaidAuthorization({request,approvalText:value("--approval-text"),
  approvedBy:value("--approved-by"),approvedAt:new Date().toISOString()});
assertImmutableMem2PaidAuthorization(authorization,request);
const extended=buildA1ExtendedBudgetLedger(ledger,{effectiveHardCapCny:budget.effectiveHardCapCny,
  minimumRequiredHardCapCny:budget.protectedTotalCny,a1BudgetExtensionAmendmentSha256:amendmentSha});
const authOut=file("--output"),ledgerOut=file("--ledger-output");
await mkdir(path.dirname(authOut),{recursive:true});await mkdir(path.dirname(ledgerOut),{recursive:true});
await writeFile(authOut,`${JSON.stringify(authorization,null,2)}\n`,{flag:"wx"});
await writeFile(ledgerOut,`${JSON.stringify(extended,null,2)}\n`,{flag:"wx"});
console.log(JSON.stringify({status:"MEM2_CAL_A1_CAUSAL_AUTHORIZATION_MATERIALIZED",authorizationHash:authorization.contentHash,
  extendedLedgerHash:extended.contentHash,providerCalls:0,secretReads:0,calCausalY:0,testCausalY:0},null,2));
