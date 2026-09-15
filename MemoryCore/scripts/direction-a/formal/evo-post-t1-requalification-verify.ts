import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashCanonical } from "../../../src/evaluation/direction-a/formal/index.js";
import { assertActualArmStartOrder, type PairSchedule } from "../../../src/evaluation/direction-a/formal/acquisition/integrity.js";
import { parseCurrentFormalExecutionEvents } from "../../../src/evaluation/direction-a/formal/prepilot/execution-state-attestation.js";

type Json = Record<string, any>;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../../");
const workspaceRoot = path.dirname(repoRoot);
const outputRoot = path.join(workspaceRoot, "Direction_A_Evo_PostT1_Requalification_Closure_v2");
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const readJson = async (file: string): Promise<Json> => JSON.parse(await readFile(file, "utf8")) as Json;

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function selfHash(document: Json, name: string): void {
  const { contentHash, ...body } = document;
  assert(typeof contentHash === "string" && hashCanonical(body) === contentHash, `SELF_HASH_FAIL:${name}`);
}

async function verifyBinding(binding: Json): Promise<void> {
  const file = path.resolve(workspaceRoot, binding.path);
  const bytes = await readFile(file);
  assert(bytes.length === binding.bytes && sha(bytes) === binding.sha256, `BINDING_FAIL:${binding.path}`);
}

async function main(): Promise<void> {
  const names = (await readdir(outputRoot)).sort();
  const inventory = await readJson(path.join(outputRoot, "SHA256_INVENTORY.json"));
  selfHash(inventory, "SHA256_INVENTORY.json");
  const expectedNames = [...inventory.files.map((row: Json) => row.path), "SHA256_INVENTORY.json"].sort();
  assert(JSON.stringify(names) === JSON.stringify(expectedNames), "INVENTORY_FILE_SET_MISMATCH");
  for (const row of inventory.files as Json[]) {
    const bytes = await readFile(path.join(outputRoot, row.path));
    assert(bytes.length === row.bytes && sha(bytes) === row.sha256, `INVENTORY_HASH_FAIL:${row.path}`);
    if (row.path.endsWith(".json")) selfHash(JSON.parse(bytes.toString("utf8")) as Json, row.path);
  }

  const [integrity, attestations, budget, fixed4, provenance, bank, rule, abc, ablation, checkpoint] = await Promise.all([
    "01_FINAL_T1_RECOVERY_INTEGRITY_CONSOLIDATION.json", "02_FINAL_RETRY_AWARE_PAIR_ORDER_ATTESTATIONS.json",
    "03_FINAL_RECOVERY_BUDGET_CLOSURE.json", "04_REPAIRED_T1_FIXED4_BANK.json", "05_REPAIRED_T1_PROVENANCE_MAP.json",
    "06_REPAIRED_POST_T1_8TASK_10GROUP_BANK.json", "07_POST_T1_REQUALIFICATION_RULE_FREEZE.json",
    "08_POST_T1_ABC_RESULTS.json", "09_POST_T1_PROCESS_ABLATION.json", "10_POST_T1_MODEL_CHECKPOINT.json",
  ].map((name) => readJson(path.join(outputRoot, name))));

  assert(integrity.status === "PASS" && integrity.recoveryScientificSlotsComplete === 8
    && integrity.postInitialRecoveryProviderCallsObserved === 84 && integrity.scientificFailureRetried === false,
  "RECOVERY_INTEGRITY_FAIL");
  assert(integrity.genericScientificFailureToZeroMapping === false && integrity.currentRunHardZero.secretReads === 0,
    "ANTI_CENSORING_OR_SECRET_BOUNDARY_FAIL");
  assert(budget.finalObservedSpendCny === 15.85953 && budget.providerCalls.allFiveJournals === 324
    && budget.reservationClosure.activeReservationCount === 0 && budget.globalHardCapCny === 110,
  "BUDGET_CLOSURE_FAIL");
  let journalSpend = 0; let journalCalls = 0;
  for (const summary of budget.journals as Json[]) {
    const raw = await readFile(path.resolve(workspaceRoot, summary.journal.path));
    assert(sha(raw) === summary.journal.sha256, `JOURNAL_SHA_FAIL:${summary.label}`);
    const events = parseCurrentFormalExecutionEvents(raw.toString("utf8"));
    assert(events.at(-1)?.eventHash === summary.headHash && events.length === summary.eventCount, `JOURNAL_CHAIN_FAIL:${summary.label}`);
    const calls = events.filter((row) => row.eventType === "PROVIDER_CALL_COMPLETED");
    journalCalls += calls.length;
    journalSpend += calls.reduce((sum, row) => sum + (row.amountCny ?? 0), 0);
  }
  assert(journalCalls === 324 && Math.abs(journalSpend - 15.85953) <= 1e-9, "RAW_JOURNAL_BUDGET_REPLAY_FAIL");

  const prepared = await readJson(path.join(workspaceRoot, "Direction_A_Evo_Engineering_First_T1_Runtime_v2/prepared/T1_PREPARED_EXECUTION_MANIFEST.json"));
  for (const row of attestations.attestations as Json[]) {
    selfHash(row, `ATTESTATION:${row.domain}:P${row.pairIndex}`);
    const group = prepared.groups.find((candidate: Json) => candidate.causalGroupId === row.causalGroupId);
    assert(group, `ATTESTATION_GROUP_MISSING:${row.causalGroupId}`);
    assertActualArmStartOrder(group.pairSchedule as PairSchedule, row.pairIndex, row.actualRetryAwareStartOrder);
    assert(row.starts.every((start: Json) => typeof start.eventHash === "string" && start.eventHash.length === 64), "ATTESTATION_EVENT_HASH_MISSING");
  }
  const d3p3 = attestations.attestations.find((row: Json) => row.domain === "d3" && row.pairIndex === 3);
  assert(JSON.stringify(d3p3.actualRetryAwareStartOrder) === JSON.stringify(["REMOVE", "REMOVE", "FULL"]), "D3_P3_RETRY_CHAIN_FAIL");

  assert(fixed4.groupCount === 2 && fixed4.pairCount === 8 && fixed4.armOutcomeCount === 16, "FIXED4_SHAPE_FAIL");
  for (const group of fixed4.groups as Json[]) {
    selfHash(group, `FIXED4:${group.officialDomainId}`);
    const theta = group.pairs.reduce((sum: number, pair: Json) => sum + pair.full.utility - pair.remove.utility, 0) / 4;
    assert(Math.abs(theta - group.thetaHatFixed4) <= 1e-12, `FIXED4_THETA_REPLAY_FAIL:${group.officialDomainId}`);
    for (const pair of group.pairs as Json[]) {
      await verifyBinding(pair.full.evidence.result);
      await verifyBinding(pair.remove.evidence.result);
      assert(pair.full.totalCases === group.frozenTotalCases && pair.remove.totalCases === group.frozenTotalCases,
        `FIXED4_DENOMINATOR_FAIL:${group.officialDomainId}:P${pair.pairIndex}`);
    }
  }
  assert(provenance.admittedPairCount === 8 && provenance.excludedOriginalMismatchedPairCount === 4
    && provenance.originalWrongOrderPairsReAdmitted === false, "PROVENANCE_MAP_FAIL");
  assert(bank.independentCompleteTasks === 8 && bank.causalGroups === 10 && bank.rows.length === 10
    && new Set(bank.rows.map((row: Json) => row.statisticalClusterId)).size === 8
    && new Set(bank.rows.map((row: Json) => row.causalGroupId)).size === 10, "BANK_SHAPE_FAIL");
  for (const row of bank.rows as Json[]) selfHash(row, `BANK_ROW:${row.causalGroupId}`);
  assert(rule.modelSelectionRule.contentHash === "5fd5bb424985eee5c6e2e840a0d4bb7c2077f489859c81e325f2faec65df6690"
    && rule.stabilityRule.contentHash === "01c2607400395e0204ca1b1b10ef9fb467d9c2f92df9f224df36bcb0e7ebca02"
    && rule.freezeOccurredBeforeRecoveredYConsumption === true, "FROZEN_RULE_PROVENANCE_FAIL");
  assert(Object.keys(abc.candidates).length === 3 && Object.keys(ablation.candidates).length === 3, "MODEL_EVALUATION_SHAPE_FAIL");
  assert(checkpoint.historicalCheckpointStatusCarriedForward === false && checkpoint.historicalStableForced === false,
    "STALE_CHECKPOINT_REUSE_FAIL");

  if (checkpoint.checkpoint === "STABLE") {
    const freshNames = ["11_FINAL_PROPOSED_MODEL_FREEZE.json", "12_FINAL_PRIMARY_BASELINE_FREEZE.json",
      "13_FINAL_STRONG_COMPARATOR_FREEZE.json", "14_FRESH_AFFORDABILITY_AND_RESERVATION.json",
      "15_FRESH_PREFIX_FREEZE.json", "16_FINAL_MODEL_SET_FREEZE.json", "17_FRESH_AUTHORIZATION_REQUEST.json",
      "WORKBUDDY_EVO_FRESH_REQUALIFIED.md"];
    freshNames.forEach((name) => assert(names.includes(name), `STABLE_ARTIFACT_MISSING:${name}`));
    assert(!names.includes("11_T2_TRIGGER_AND_NEXT_ACTION.json"), "STABLE_HAS_T2_ARTIFACT");
    const request = await readJson(path.join(outputRoot, "17_FRESH_AUTHORIZATION_REQUEST.json"));
    assert(request.status === "PENDING_RESEARCHER_REAUTHORIZATION" && request.authorized === false && request.executeNow === false
      && request.allowPaidExecution === false && request.freshN === 9 && request.globalHardCapCny === 110
      && request.priorReconciledSpendCny === 15.85953 && request.protectedTotalCny === 105.2680365,
    "FRESH_REQUEST_BOUNDARY_FAIL");
    assert(Object.keys(request.requiredBindingPaths).length === request.requiredBindingsCount
      && Object.keys(request.requiredBindings).length === request.requiredBindingsCount
      && hashCanonical(request.requiredBindings) === request.requiredBindingsHash, "FRESH_REQUEST_BINDING_SHAPE_FAIL");
    for (const [key, relativePath] of Object.entries(request.requiredBindingPaths) as Array<[string, string]>) {
      const bytes = await readFile(path.resolve(workspaceRoot, relativePath));
      assert(sha(bytes) === request.requiredBindings[key], `FRESH_REQUEST_BINDING_FAIL:${key}`);
    }
  } else {
    assert(checkpoint.checkpoint === "NOT_STABLE" && checkpoint.next === "READY_FOR_EVO_T2_RESEARCHER_DECISION", "NOT_STABLE_BRANCH_FAIL");
    assert(names.includes("11_T2_TRIGGER_AND_NEXT_ACTION.json") && !names.includes("17_FRESH_AUTHORIZATION_REQUEST.json"), "T2_ARTIFACT_BRANCH_FAIL");
    const t2 = await readJson(path.join(outputRoot, "11_T2_TRIGGER_AND_NEXT_ACTION.json"));
    assert(t2.authorized === false && t2.providerCallsAuthorizedNow === 0 && t2.exactCausalGroupIds.length === 2 && t2.t3 === "PROHIBITED",
      "T2_RESEARCHER_BOUNDARY_FAIL");
  }
  process.stdout.write(`EVO_POST_T1_REQUALIFICATION_VERIFY_PASS\nCHECKPOINT=${checkpoint.checkpoint}\nNEXT=${checkpoint.next}\nFILES=${names.length}\nPROVIDER_CALLS_DURING_VERIFY=0\nMODEL_API_CALLS_DURING_VERIFY=0\nSECRET_READS_DURING_VERIFY=0\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
