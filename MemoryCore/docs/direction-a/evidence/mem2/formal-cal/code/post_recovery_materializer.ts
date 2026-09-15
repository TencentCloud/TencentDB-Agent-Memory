import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  a1Bound,
  a1Random,
  assertA1Hash,
  assertPredictionPopulation,
  bindA1,
  freezeAlphaPlan,
  populationWeights,
  srsworIndices,
  type AlphaPlan,
  type PredictionPopulation,
} from "../../MemoryCore/src/evaluation/direction-a/formal/analysis/mem2-a1.js";
import { hashCanonical, sha256 } from "../../MemoryCore/src/evaluation/direction-a/formal/core/canonical.js";
import {
  buildMem2ContinuousReferenceArtifact,
  type Mem2ContinuousReferenceArtifact,
  type Mem2ReferenceArm,
  type Mem2ReferencePairSlot,
} from "../../MemoryCore/src/evaluation/direction-a/formal/teacher/mem2-continuous-reference.js";

const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1")), "..");
const repoRoot = path.resolve(packageRoot, "..");
const originalRuntime = path.join(repoRoot, "Direction_A_Mem2_A1_CAL_Causal_Audit_Runtime_v1");
const recoveryRuntime = path.join(repoRoot, "Direction_A_Mem2_A1_DNS_Outage_Recovery_Runtime_v1");
const recoveryPackage = path.join(repoRoot, "Direction_A_Mem2_A1_DNS_Outage_Recovery_v1");
const causalHandoff = path.join(repoRoot, "Direction_A_Mem2_A1_CAL_Causal_Audit_Handoff_v2");

const input = {
  reconciliation: path.join(repoRoot, "Direction_A_Mem2_A1_DNS_Outage_Recovery_Runtime_v1_RECONCILIATION.json"),
  recoveryInventory: path.join(repoRoot, "Direction_A_Mem2_A1_DNS_Outage_Recovery_Runtime_v1_SHA256_INVENTORY.json"),
  originalInventory: path.join(originalRuntime, "WORKBUDDY_SHA256_INVENTORY.json"),
  recoveryHandoff: path.join(recoveryRuntime, "WORKBUDDY_RECOVERY_HANDOFF.json"),
  recoveryPlan: path.join(recoveryPackage, "artifacts", "CAL_A1_OUTAGE_RECOVERY_PLAN.json"),
  request: path.join(recoveryPackage, "CAL_A1_DNS_OUTAGE_RECOVERY_AUTHORIZATION_REQUEST.json"),
  authorization: path.join(recoveryPackage, "authorization", "AUTHORIZATION.json"),
  sample: path.join(recoveryPackage, "artifacts", "CAL_A1_SRSWOR_SAMPLE_MANIFEST.json"),
  population: path.join(recoveryPackage, "evidence", "historical", "CAL_COMPLETE_PREDICTION_POPULATION.json"),
  alpha: path.join(causalHandoff, "artifacts", "a1-budget-extension", "CAL_PRE_DRAW_ALPHA_PLANS.json"),
  sequence: path.join(causalHandoff, "artifacts", "a1-budget-extension", "ACTIVE_TIER_AND_FINAL_CAL_SEQUENCE.json"),
  floors: path.join(causalHandoff, "evidence", "cal-x", "CAL_FINAL_POLICY_OPERATIONAL_FLOORS.json"),
  cheapX: path.join(causalHandoff, "evidence", "cal-x", "CAL_CHEAP_X_FREEZE.json"),
  frozenSamplerSource: path.join(causalHandoff, "changed", "src", "evaluation", "direction-a", "formal", "analysis", "mem2-a1.ts"),
};

type Json = Record<string, any>;
type Started = { attemptId: string; causalGroupId: string; pairId: string; pairIndex: number; arm: "FULL" | "REMOVE"; source: "ORIGINAL" | "RECOVERY" };
type ValidArm = Started & { resultFile: string; armValue: Mem2ReferenceArm };

function fail(message: string): never { throw new Error(message); }
function eq(actual: unknown, expected: unknown, label: string): void {
  if (hashCanonical(actual) !== hashCanonical(expected)) fail(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
async function json(file: string): Promise<Json> { return JSON.parse(await readFile(file, "utf8")); }
function assertBound(value: Json, label: string): void {
  const { contentHash, ...body } = value;
  if (typeof contentHash !== "string" || hashCanonical(body) !== contentHash) fail(`${label}_CONTENT_HASH_MISMATCH`);
}
async function byteHash(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}
async function verifyInventory(file: string, root: string, expectedFileHash: string): Promise<{ fileCount: number; inventoryFileSha256: string }> {
  const fileHash = await byteHash(file);
  if (fileHash !== expectedFileHash) fail(`INVENTORY_FILE_HASH_MISMATCH_${path.basename(file)}`);
  const manifest = await json(file);
  const entries = manifest.inventory as Record<string, string>;
  if (!entries || Object.keys(entries).length !== manifest.fileCount) fail(`INVENTORY_COUNT_MISMATCH_${path.basename(file)}`);
  for (const [relative, expected] of Object.entries(entries)) {
    const actual = await byteHash(path.join(root, ...relative.split("/")));
    if (actual !== expected) fail(`INVENTORY_ENTRY_MISMATCH_${relative}`);
  }
  return { fileCount: manifest.fileCount, inventoryFileSha256: fileHash };
}
async function journalFiles(root: string): Promise<string[]> {
  const dirs = (await readdir(root, { withFileTypes: true })).filter(row => row.isDirectory() && row.name !== "calls");
  return dirs.map(row => path.join(root, row.name, "journal.jsonl"));
}
async function parseJournals(root: string, source: Started["source"]): Promise<{ starts: Map<string, Started>; validIds: Set<string>; invalidIds: Set<string>; originalPairIndices: Map<string, Set<number>> }> {
  const starts = new Map<string, Started>();
  const validIds = new Set<string>();
  const invalidIds = new Set<string>();
  const originalPairIndices = new Map<string, Set<number>>();
  for (const file of await journalFiles(root)) {
    const rows = (await readFile(file, "utf8")).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    let previous = "GENESIS";
    for (const row of rows) {
      if (row.previousEventHash !== previous) fail(`BROKEN_JOURNAL_CHAIN_${file}_${row.sequence}`);
      const { eventHash, ...body } = row;
      if (hashCanonical(body) !== eventHash) fail(`JOURNAL_EVENT_HASH_MISMATCH_${file}_${row.sequence}`);
      previous = eventHash;
      if (source === "ORIGINAL" && row.eventType === "REFERENCE_SLOT_STARTED") {
        const id = row.payload.causalGroupId as string;
        const indices = originalPairIndices.get(id) ?? new Set<number>();
        indices.add(row.payload.pairIndex);
        originalPairIndices.set(id, indices);
      }
      if (row.eventType === "ATTEMPT_STARTED") {
        const pairIndex = Number(row.payload.pairIndex);
        const causalGroupId = String(row.pairId).replace(/:pair-\d+$/, "");
        const started: Started = { attemptId: row.attemptId, causalGroupId, pairId: row.pairId, pairIndex, arm: row.arm, source };
        if (starts.has(started.attemptId)) fail(`DUPLICATE_ATTEMPT_ID_${started.attemptId}`);
        starts.set(started.attemptId, started);
      } else if (row.eventType === "ATTEMPT_VALID") validIds.add(row.attemptId);
      else if (row.eventType === "ATTEMPT_TECHNICAL_INVALID") invalidIds.add(row.attemptId);
    }
  }
  for (const id of [...validIds, ...invalidIds]) if (!starts.has(id)) fail(`TERMINAL_WITHOUT_START_${id}`);
  for (const id of validIds) if (invalidIds.has(id)) fail(`ATTEMPT_HAS_TWO_TERMINALS_${id}`);
  return { starts, validIds, invalidIds, originalPairIndices };
}
async function resultMap(root: string): Promise<Map<string, { file: string; value: Json }>> {
  const calls = path.join(root, "calls");
  const files = (await readdir(calls)).filter(name => name.endsWith(".result.json"));
  const map = new Map<string, { file: string; value: Json }>();
  for (const name of files) {
    const file = path.join(calls, name);
    const value = await json(file);
    assertBound(value, `CALL_RESULT_${name}`);
    if (map.has(value.attemptId)) fail(`DUPLICATE_RESULT_ATTEMPT_${value.attemptId}`);
    map.set(value.attemptId, { file, value });
  }
  return map;
}
function observedArm(started: Started, resultEntry: { file: string; value: Json }): ValidArm {
  const metadata = resultEntry.value.result?.technicalMetadata;
  if (resultEntry.value.attemptId !== started.attemptId || resultEntry.value.arm !== started.arm
    || metadata?.observation !== "SCIENTIFICALLY_OBSERVED" || metadata.arm !== started.arm
    || !Number.isFinite(metadata.utility) || metadata.utility < 0 || metadata.utility > 1) {
    fail(`VALID_RESULT_IDENTITY_OR_VALUE_INVALID_${started.attemptId}`);
  }
  const armValue: any = {
    arm: started.arm,
    observation: "SCIENTIFICALLY_OBSERVED",
    utility: metadata.utility,
    strictPass: metadata.strictPass,
    attemptId: started.attemptId,
    rawCompletionHash: metadata.rawCompletionHash,
    outcomeHash: metadata.outcomeHash,
  };
  if (metadata.scientificActionFailure) armValue.scientificActionFailure = metadata.scientificActionFailure;
  return { ...started, resultFile: path.relative(repoRoot, resultEntry.file).replaceAll("\\", "/"), armValue };
}
async function writeBound(name: string, body: Json): Promise<Json> {
  const value = { ...body, contentHash: hashCanonical(body) };
  await writeFile(path.join(packageRoot, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return value;
}

async function main(): Promise<void> {
const reconciliation = await json(input.reconciliation); assertBound(reconciliation, "RECOVERY_RECONCILIATION");
const recoveryHandoff = await json(input.recoveryHandoff); assertBound(recoveryHandoff, "RECOVERY_HANDOFF");
const recoveryPlan = await json(input.recoveryPlan); assertBound(recoveryPlan, "RECOVERY_PLAN");
const request = await json(input.request); assertBound(request, "RECOVERY_REQUEST");
const authorization = await json(input.authorization); assertBound(authorization, "RECOVERY_AUTHORIZATION");
const sample = await json(input.sample); assertBound(sample, "CAL_SAMPLE");
const population = await json(input.population) as PredictionPopulation; assertPredictionPopulation(population);
const alphaEnvelope = await json(input.alpha); assertBound(alphaEnvelope, "ALPHA_ENVELOPE");
const sequence = await json(input.sequence); assertBound(sequence, "CAL_SEQUENCE");
const floors = await json(input.floors); assertBound(floors, "CAL_FLOORS");
const cheapX = await json(input.cheapX); assertBound(cheapX, "CAL_CHEAP_X");
const plans = alphaEnvelope.plans as AlphaPlan[];
for (const plan of plans) {
  assertA1Hash(plan);
  if (freezeAlphaPlan(population, plan.policyId, plan.metric, plan.n).contentHash !== plan.contentHash) fail(`ALPHA_PLAN_DERIVATION_MISMATCH_${plan.policyId}_${plan.metric}`);
}

eq(sample.contentHash, "45206e817ceb52666651cb9108cbeaa4bc0964ecd3f57624cd9154094dd276c7", "FROZEN_SAMPLE_HASH");
eq(sequence.FINAL_CAL_SEQUENCE, ["MEM2_COVERAGE_70", "MEM2_COVERAGE_80"], "FROZEN_SEQUENCE");
eq(sequence.FORMAL_CAL_AUDIT_N, 36, "FROZEN_N");
eq(sample.selectedComponentIds, srsworIndices(population.N, sample.n, a1Random(sample.seed)).map(index => population.rows[index].componentId), "SAMPLE_DRAW_REPLAY");
eq(sample.selectedComponentIds, recoveryPlan.groups.map((row: Json) => row.componentId), "RECOVERY_PLAN_GROUP_ORDER");
eq(sample.selectedComponentIds, recoveryHandoff.groups.map((row: Json) => row.componentId), "RECOVERY_HANDOFF_GROUP_ORDER");
eq(request.contentHash, authorization.requestContentHash, "AUTHORIZATION_REQUEST_IDENTITY");
eq(request.contentHash, recoveryHandoff.requestHash, "HANDOFF_REQUEST_IDENTITY");
eq(authorization.contentHash, recoveryHandoff.authorizationHash, "HANDOFF_AUTHORIZATION_IDENTITY");
eq(recoveryPlan.planContentHash, recoveryHandoff.recoveryPlanHash, "HANDOFF_PLAN_IDENTITY");
eq(reconciliation.contentHash, "5d0ae41d257133cb436debb685ef94e643e127516ddef59c499cc7152535687c", "RECONCILIATION_HASH");
eq(reconciliation.sample.hash, sample.contentHash, "RECONCILIATION_SAMPLE_HASH");
if (reconciliation.entitlements.oneForOneDispatchedNotInPlan !== 0 || reconciliation.entitlements.oneForOnePlannedNotDispatched !== 0
  || reconciliation.entitlements.duplicateAttemptIds !== 0 || reconciliation.entitlements.normalArms !== 0
  || reconciliation.entitlements.ordinaryTechnicalRetry !== 0 || reconciliation.entitlements.nonCertifiedSourceAttemptsUsed !== 0
  || reconciliation.forbiddenStages.sealedTestArtifacts !== 0 || reconciliation.forbiddenStages.evoArtifacts !== 0
  || reconciliation.forbiddenStages.eBArtifacts !== 0 || reconciliation.forbiddenStages.testCausalY !== 0) fail("RECOVERY_OR_FORBIDDEN_STAGE_RECONCILIATION_FAILURE");

const recoveryInventory = await verifyInventory(input.recoveryInventory, recoveryRuntime, reconciliation.runtimeInventory.sha256);
const originalInventoryExpected = "4eceeaebd52ebd0148edf94f83258258da4f8bb489f7c045d82a94935d35ae9f";
const originalInventory = await verifyInventory(input.originalInventory, originalRuntime, originalInventoryExpected);
if (originalInventory.fileCount !== 1151 || recoveryInventory.fileCount !== 538) fail("RUNTIME_INVENTORY_FILE_COUNT_MISMATCH");

const original = await parseJournals(originalRuntime, "ORIGINAL");
const recovery = await parseJournals(recoveryRuntime, "RECOVERY");
const allAttemptIds = [...original.starts.keys(), ...recovery.starts.keys()];
if (new Set(allAttemptIds).size !== allAttemptIds.length) fail("CROSS_RUNTIME_DUPLICATE_ATTEMPT_ID");
const originalResults = await resultMap(originalRuntime);
const recoveryResults = await resultMap(recoveryRuntime);
const validArms: ValidArm[] = [];
for (const [state, results] of [[original, originalResults], [recovery, recoveryResults]] as const) {
  for (const id of state.validIds) {
    const result = results.get(id); if (!result) fail(`VALID_ATTEMPT_RESULT_MISSING_${id}`);
    validArms.push(observedArm(state.starts.get(id)!, result));
  }
}
const armKeys = validArms.map(row => `${row.causalGroupId}|${row.pairIndex}|${row.arm}`);
if (new Set(armKeys).size !== armKeys.length) fail("MERGED_DUPLICATE_VALID_ARM_IDENTITY");

const plannedEntitlements = recoveryPlan.groups.flatMap((row: Json) => row.entitlements ?? []).map((row: Json) => `${row.componentId}|${row.pairIndex}|${row.arm}|${row.sourceAttemptId}`).sort();
const dispatchedEntitlements = [...recovery.starts.values()].map(row => {
  const handoffAttempt = recoveryHandoff.groups.flatMap((group: Json) => group.attempts).find((attempt: Json) => attempt.attemptId === row.attemptId);
  if (!handoffAttempt || handoffAttempt.componentId !== row.causalGroupId || handoffAttempt.pairIndex !== row.pairIndex || handoffAttempt.arm !== row.arm || handoffAttempt.outcome !== "VALID") fail(`RECOVERY_HANDOFF_ATTEMPT_MISMATCH_${row.attemptId}`);
  return `${row.causalGroupId}|${row.pairIndex}|${row.arm}|${handoffAttempt.sourceAttemptId}`;
}).sort();
eq(dispatchedEntitlements, plannedEntitlements, "CERTIFIED_ENTITLEMENTS_ONE_FOR_ONE");

const sampleRows = new Map(population.rows.map(row => [row.componentId, row]));
const references: Mem2ContinuousReferenceArtifact[] = [];
const provenance: Json[] = [];
for (const causalGroupId of sample.selectedComponentIds as string[]) {
  const indices = [...(original.originalPairIndices.get(causalGroupId) ?? [])].sort((a, b) => a - b);
  if (!indices.length || indices.some((value, index) => value !== index + 1)) fail(`ORIGINAL_PAIR_INDEX_PROVENANCE_INVALID_${causalGroupId}`);
  const slots: Mem2ReferencePairSlot[] = indices.map(pairIndex => {
    const pairId = `${causalGroupId}:pair-${pairIndex}`;
    const getArm = (arm: "FULL" | "REMOVE"): Mem2ReferenceArm => {
      const observed = validArms.find(row => row.causalGroupId === causalGroupId && row.pairIndex === pairIndex && row.arm === arm);
      if (observed) return observed.armValue;
      const originalInvalid = [...original.invalidIds].map(id => original.starts.get(id)!).find(row => row.causalGroupId === causalGroupId && row.pairIndex === pairIndex && row.arm === arm);
      if (!originalInvalid) fail(`MERGED_SLOT_ARM_MISSING_${causalGroupId}_${pairIndex}_${arm}`);
      return { arm, observation: "TECHNICAL_INVALID", technicalReason: "PROVIDER_NETWORK_INFRASTRUCTURE_FAILURE", attemptId: originalInvalid.attemptId };
    };
    return { pairId, pairIndex, full: getArm("FULL"), remove: getArm("REMOVE") };
  });
  const fourthValidPosition = slots.map(slot => slot.full.observation === "SCIENTIFICALLY_OBSERVED" && slot.remove.observation === "SCIENTIFICALLY_OBSERVED").reduce<number[]>((acc, valid, index) => valid ? [...acc, index] : acc, [])[3];
  if (fourthValidPosition === undefined) fail(`REFERENCE_GENUINELY_UNAVAILABLE_${causalGroupId}`);
  const materializedSlots = slots.slice(0, fourthValidPosition + 1);
  const row = sampleRows.get(causalGroupId); if (!row) fail(`SAMPLE_ROW_MISSING_${causalGroupId}`);
  const reference = buildMem2ContinuousReferenceArtifact({ causalGroupId, statisticalClusterId: row.statisticalClusterId,
    slots: materializedSlots, authorityBindingHash: population.frozenDesignBindingHash, protocolHash: population.protocolHash,
    profileHash: population.profileHash, snapshotHash: population.sourceSnapshotCodeHash, verifierHash: population.verifierHash });
  references.push(reference);
  provenance.push({ causalGroupId, allOriginalPairIndices: indices, materializedThroughPairIndex: fourthValidPosition + 1,
    selectedArmSources: reference.pairEffects.map(effect => ({ pairIndex: effect.pairIndex,
      full: validArms.find(row => row.attemptId === effect.fullAttemptId)!.source,
      remove: validArms.find(row => row.attemptId === effect.removeAttemptId)!.source,
      fullResultFile: validArms.find(row => row.attemptId === effect.fullAttemptId)!.resultFile,
      removeResultFile: validArms.find(row => row.attemptId === effect.removeAttemptId)!.resultFile })) });
}
if (references.filter(row => row.referenceAvailable).length !== 36) fail("REFERENCE_AVAILABILITY_NOT_36_OF_36");

const selectedIndices = sample.selectedComponentIds.map((id: string) => population.rows.findIndex(row => row.componentId === id));
const effects = sample.selectedComponentIds.map((id: string) => references.find(row => row.causalGroupId === id)!.thetaHatFixed4);
const tests: Record<string, Json> = {};
const reached: Json[] = [];
let selectedPolicyId: string | null = null;
for (const policyId of sequence.FINAL_CAL_SEQUENCE as string[]) {
  tests[policyId] = {};
  for (const metric of ["V", "G"] as const) {
    const plan = plans.find(row => row.policyId === policyId && row.metric === metric); if (!plan) fail(`FROZEN_PLAN_MISSING_${policyId}_${metric}`);
    const weights = populationWeights(population, policyId, metric);
    tests[policyId][metric] = a1Bound(plan, selectedIndices.map(index => weights[index]), effects);
  }
  const coverage = population.coverage[policyId];
  const acceptedSupport = population.rows.filter(row => row.decisions[policyId]).length;
  const statisticalPass = tests[policyId].V.pass && tests[policyId].G.pass;
  const coveragePass = coverage >= floors.minimumCoverage;
  const supportPass = acceptedSupport >= floors.minimumAcceptedSupport;
  reached.push({ policyId, populationCoverage: coverage, acceptedSupport, minimumCoverage: floors.minimumCoverage,
    minimumAcceptedSupport: floors.minimumAcceptedSupport, V: tests[policyId].V, G: tests[policyId].G,
    statisticalPass, coveragePass, supportPass, floorPass: coveragePass && supportPass });
  if (!statisticalPass) break;
  if (coveragePass && supportPass) selectedPolicyId = policyId;
}
const a1Report = bindA1({ schemaVersion: "CAL_A1_VG_INFERENCE_REPORT.v1", a1Version: "MEM2-A1-SRSWOR-TWO-LAYER-INFERENCE-V1-2026-09-09",
  populationHash: population.contentHash, sampleHash: sample.contentHash, alphaPlanHashes: plans.map(row => row.contentHash), referenceManifestHash: hashCanonical(references),
  tests, actuallyReachedPolicyIds: reached.map(row => row.policyId), formalConfidenceEvidence: true, metrics: ["V", "G"],
  deltaV: "NOT_BOUND_FOR_THIS_FROZEN_CAL_SEQUENCE" });
const sequenceReport = bindA1({ schemaVersion: "MEM2_CAL_FIXED_SEQUENCE_REPORT.v1", frozenSequenceArtifactHash: sequence.contentHash,
  inferenceReportHash: a1Report.contentHash, orderedPolicyIds: sequence.FINAL_CAL_SEQUENCE, reached,
  fixedSequenceStopPoint: reached.at(-1)!.policyId, selectedPolicyId,
  status: selectedPolicyId ? "CERTIFIED_OPERATING_POINT" : "NO_CERTIFIED_OPERATING_POINT" });

const integrity = await writeBound("00_POST_RECOVERY_INTEGRITY_REPORT.json", {
  schemaVersion: "direction-a.mem2-cal-a1.post-recovery-integrity.v1", status: "PASS", sampleCount: 36,
  checks: { reconciliationBound: true, sampleOrderAndDrawReplay: true, authorizationRequestPlanIdentity: true,
    certifiedEntitlementsOneForOne: true, noDuplicateAttempts: true, noUncertainDispatch: true, noNormalOrOrdinaryRetry: true,
    historicalRuntimeByteInventoryPreserved: true, deterministicArmPairMerge: true, frozenPopulationAndAlphaPlansReproduced: true,
    noTestEvoOrEBArtifactsEntered: true },
  knownNonBlockingReportingDefect: { groupsCompleteAtFirstFour: 35, authoritativeRawMergeCompleteGroups: 36 },
  recoverySecretReadsHistorical: reconciliation.secrets.secretReads, secretReadsThisGoal: 0, providerCallsThisGoal: 0,
  originalRuntimeInventory: originalInventory, recoveryRuntimeInventory: recoveryInventory,
  reconciliationHash: reconciliation.contentHash, recoveryHandoffHash: recoveryHandoff.contentHash,
});
const referenceManifest = await writeBound("01_FIXED4_REFERENCE_MANIFEST.json", {
  schemaVersion: "direction-a.mem2-cal-a1.fixed4-reference-manifest.v1", sampleHash: sample.contentHash,
  mergeRule: "ORIGINAL_VALID_UNION_CERTIFIED_RECOVERY_VALID_BY_ORIGINAL_PAIR_INDEX_FIRST_FOUR_COMPLETE",
  references, provenance,
});
await writeBound("02_REFERENCE_AVAILABILITY_REPORT.json", {
  schemaVersion: "direction-a.mem2-cal-a1.reference-availability.v1", sampleCount: 36, availableCount: 36,
  unavailableCount: 0, availabilityRate: 1, scientificActionFailureCount: references.reduce((sum, row) => sum + row.scientificActionFailures.count, 0),
  trueTechnicalInvalidCountInMaterializedReferenceSlots: references.reduce((sum, row) => sum + row.trueTechnicalInvalids.count, 0),
  handling: "NO_COMPLETE_CASE_DELETION; FROZEN_WORST_CASE_WOULD_APPLY_IF_UNAVAILABLE", referenceManifestHash: referenceManifest.contentHash,
});
await writeFile(path.join(packageRoot, "03_A1_INFERENCE_REPORT.json"), `${JSON.stringify(a1Report, null, 2)}\n`, "utf8");
await writeFile(path.join(packageRoot, "04_CAL_FIXED_SEQUENCE_REPORT.json"), `${JSON.stringify(sequenceReport, null, 2)}\n`, "utf8");
await writeBound("06_INPUT_BINDINGS.json", {
  schemaVersion: "direction-a.mem2-cal-a1.formal-input-bindings.v1", populationHash: population.contentHash,
  sampleHash: sample.contentHash, alphaEnvelopeHash: alphaEnvelope.contentHash, alphaPlanHashes: plans.map(row => row.contentHash),
  frozenSequenceHash: sequence.contentHash, floorsHash: floors.contentHash, cheapXFreezeHash: cheapX.contentHash,
  recoveryRequestHash: request.contentHash, recoveryAuthorizationHash: authorization.contentHash, recoveryPlanArtifactHash: recoveryPlan.contentHash,
  recoveryPlanCertifiedSpecHash: recoveryPlan.planContentHash,
  recoveryHandoffHash: recoveryHandoff.contentHash, reconciliationHash: reconciliation.contentHash,
  originalRuntimeInventorySha256: originalInventory.inventoryFileSha256, recoveryRuntimeInventorySha256: recoveryInventory.inventoryFileSha256,
  frozenSamplerSourceSha256: await byteHash(input.frozenSamplerSource), materializerSha256: await byteHash(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1")),
  providerCallsThisGoal: 0, secretReadsThisGoal: 0,
});

const fmt = (value: number) => Number(value.toPrecision(12)).toString();
const lines = ["# Mem2 CAL A1 Formal Result", "", `Integrity: **${integrity.status}** (36/36 frozen sample).`,
  "", "Reference Availability: **36/36 (100%)**. No complete-case deletion was used.", ""];
for (const row of reached) lines.push(`## ${row.policyId}`, "",
  `- Population coverage: ${fmt(row.populationCoverage)}; accepted support: ${row.acceptedSupport}/105; floors: ${row.floorPass ? "PASS" : "FAIL"}.`,
  `- V: estimate ${fmt(row.V.estimate)}, one-sided 95% LCB ${fmt(row.V.lowerConfidenceBound95)}, mM ${fmt(row.V.mM)}, mS ${fmt(row.V.mS)}, alphaM ${fmt(plans.find(p => p.policyId === row.policyId && p.metric === "V")!.alphaM)}, alphaS ${fmt(plans.find(p => p.policyId === row.policyId && p.metric === "V")!.alphaS)}.`,
  `- G: estimate ${fmt(row.G.estimate)}, one-sided 95% LCB ${fmt(row.G.lowerConfidenceBound95)}, mM ${fmt(row.G.mM)}, mS ${fmt(row.G.mS)}, alphaM ${fmt(plans.find(p => p.policyId === row.policyId && p.metric === "G")!.alphaM)}, alphaS ${fmt(plans.find(p => p.policyId === row.policyId && p.metric === "G")!.alphaS)}.`,
  `- Statistical V/G IUT: ${row.statisticalPass ? "PASS" : "FAIL"}.`, "");
lines.push("## Decision", "", `- Fixed-sequence stop point: ${sequenceReport.fixedSequenceStopPoint}.`,
  `- Selected operating point: ${selectedPolicyId ?? "NO_CERTIFIED_OPERATING_POINT"}.`,
  `- Formal CAL: ${selectedPolicyId ? "PASS" : "FAIL"}.`,
  "- DeltaV: not part of the frozen CAL V/G alpha-plan bundle and not used for passage.",
  `- Original causal-audit cost: CNY ${fmt(1.378116)}; DNS recovery cost: CNY ${fmt(reconciliation.budget.observedUsageCostCny)}; combined causal-audit/recovery cost: CNY ${fmt(1.378116 + reconciliation.budget.observedUsageCostCny)}.`,
  `- Online evaluator (105 CAL cheap-X NORMAL calls) cost: CNY ${fmt(cheapX.rows.reduce((sum: number, row: Json) => sum + row.observedUsageCostCny, 0))}.`,
  "- This formalization made 0 provider calls, read 0 secrets, and did not execute TEST, Evo, or E-B.", "");
await writeFile(path.join(packageRoot, "05_CAL_A1_FORMAL_RESULT.md"), `${lines.join("\n")}\n`, "utf8");

const inventoryNames = (await readdir(packageRoot, { withFileTypes: true })).filter(row => row.isFile() && row.name !== "SHA256_INVENTORY.json").map(row => row.name);
inventoryNames.push("code/post_recovery_materializer.ts", "code/README.md");
const fileHashes: Record<string, string> = {};
for (const name of inventoryNames.sort()) fileHashes[name] = await byteHash(path.join(packageRoot, ...name.split("/")));
const inventoryBody = { schemaVersion: "direction-a.immutable-result-package-sha256-inventory.v1", rootName: path.basename(packageRoot),
  fileCount: Object.keys(fileHashes).length, files: fileHashes };
const inventory = { ...inventoryBody, contentHash: hashCanonical(inventoryBody) };
await writeFile(path.join(packageRoot, "SHA256_INVENTORY.json"), `${JSON.stringify(inventory, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ integrity: integrity.status, referenceAvailability: "36/36", reached: reached.map(row => row.policyId),
  selectedOperatingPoint: selectedPolicyId, formalCal: selectedPolicyId ? "PASS" : "FAIL", tests, outputInventorySha256: inventory.contentHash }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
