import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashCanonical } from "../../../src/evaluation/direction-a/formal/index.js";

type Json = Record<string, any>;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const memoryCore = path.resolve(scriptDir, "../../../");
const repositoryRoot = path.dirname(memoryCore);
const root = path.join(repositoryRoot, "Direction_A_Evo_Engineering_First_Budget100_v1");
const currentFormal = path.join(memoryCore, ".research/direction-a/current-formal");
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function json(name: string): Promise<Json> {
  const value = JSON.parse(await readFile(path.join(root, name), "utf8")) as Json;
  const body = { ...value };
  delete body.contentHash;
  if (hashCanonical(body) !== value.contentHash) throw new Error(`CONTENT_HASH_MISMATCH:${name}`);
  return value;
}

const amendment = await json("02_ENGINEERING_FIRST_AMENDMENT.json");
const rule = await json("03_ENGINEERING_MODEL_SELECTION_RULE.json");
const baseline = await json("04_BASELINE_FREEZE_SPEC.json");
const t2 = await json("05_T2_TRIGGER_FREEZE.json");
const population = await json("06_FRESH13_POPULATION.json");
const prefix = await json("07_FRESH13_PREFIX_FREEZE.json");
const costs = await json("08_BUDGET100_STAGE_COST_TABLE.json");
const ledger = await json("09_GLOBAL_BUDGET_LEDGER_GENESIS.json");
const inference = await json("10_FUTURE_INFERENCE_FREEZE.json");
const plan = await json("12_CURRENT_T1_PLAN.json");
const authorization = await json("13_CURRENT_T1_AUTHORIZATION_REQUEST.json");
const inventory = await json("SHA256_INVENTORY.json");

if (amendment.globalNewSpendCapCny !== 100 || ledger.hardCapCny !== 100 || costs.globalCapCny !== 100) throw new Error("GLOBAL_CAP_NOT_100");
if (rule.headlineCoverage !== 0.7 || inference.headline.estimand !== "DeltaV70" || inference.bootstrap.role !== "UNCERTAINTY_REPORT_ONLY") throw new Error("ENGINEERING_ESTIMAND_OR_UNCERTAINTY_MISMATCH");
if (baseline.primary.id !== "MATCHED_CAPACITY_LEGACY_X0_BASELINE" || baseline.strongSecondary.id !== "TARGET_ONLY_SHARED_ONLY_RIDGE") throw new Error("BASELINE_FREEZE_MISMATCH");
if (t2.unstableBranch.groups.length !== 2 || t2.t3 !== "PROHIBITED") throw new Error("T2_T3_POLICY_MISMATCH");
if (population.taskCount !== 13 || population.tasks.length !== 13 || prefix.orderedTasks.length !== 13
  || new Set(prefix.orderedTasks.map((row: Json) => row.taskId)).size !== 13) throw new Error("FRESH13_PREFIX_MISMATCH");
const recomputedPrefixHash = hashCanonical(prefix.orderedTasks.map((row: Json) => ({ prefixIndex: row.prefixIndex, taskId: row.taskId,
  canonicalCausalGroupId: row.canonicalCausalGroupId, taskCandidateHash: row.taskCandidateHash, groupCandidateHash: row.groupCandidateHash })));
if (recomputedPrefixHash !== prefix.prefixHash || authorization.requiredBindings.freshPrefixHash !== prefix.prefixHash) {
  throw new Error("FRESH_PREFIX_HASH_MISMATCH");
}
if (population.q6Overlap !== 0 || population.existingTrainOverlap !== 0 || population.t1Overlap !== 0) throw new Error("FRESH_FIREWALL_MISMATCH");
if (JSON.stringify(Object.keys(costs.freshN).map(Number).sort((a, b) => b - a)) !== JSON.stringify([9, 8, 7, 6])) throw new Error("FRESH_N_LADDER_MISMATCH");
if (JSON.stringify(plan.exactCausalGroupIds) !== JSON.stringify([
  "theme_d6_w1_database_storage_greenfield_implementation:target-round-5",
  "theme_d3_w9_testing_quality_reproducibility_verification:target-round-5",
])) throw new Error("T1_IDENTITY_MISMATCH");
if (plan.expectedProviderCalls !== 216 || plan.maximumProviderCalls !== 264 || plan.stageHardCapCny !== 36.4) throw new Error("T1_CALL_OR_CAP_MISMATCH");
if (authorization.authorizationGranted || authorization.executable || !authorization.forbidden.includes("T2")
  || !authorization.forbidden.includes("FRESH_CAUSAL_Y") || !authorization.forbidden.includes("Q6")) throw new Error("AUTHORIZATION_SCOPE_MISMATCH");
if (authorization.requiredBindings.amendmentContentHash !== amendment.contentHash
  || authorization.requiredBindings.modelSelectionRuleHash !== rule.contentHash
  || authorization.requiredBindings.baselineFreezeHash !== baseline.contentHash
  || authorization.requiredBindings.t2TriggerHash !== t2.contentHash
  || authorization.requiredBindings.freshPopulationHash !== population.contentHash
  || authorization.requiredBindings.freshPrefixDocumentHash !== prefix.contentHash
  || authorization.requiredBindings.costTableHash !== costs.contentHash
  || authorization.requiredBindings.ledgerGenesisHash !== ledger.contentHash
  || authorization.requiredBindings.t1PlanHash !== plan.contentHash) throw new Error("AUTHORIZATION_BINDING_MISMATCH");
for (const row of inventory.files as Json[]) {
  const raw = await readFile(path.join(root, row.path));
  if (raw.length !== row.bytes || sha(raw) !== row.sha256) throw new Error(`INVENTORY_HASH_MISMATCH:${row.path}`);
}
const runbookRaw = await readFile(path.join(root, "WORKBUDDY_EVO_ENGINEERING_FIRST_T1_EXECUTION.md"));
if (sha(runbookRaw) !== authorization.requiredBindings.workBuddyRunbookSha256) throw new Error("WORKBUDDY_HASH_MISMATCH");
const runbookText = runbookRaw.toString("utf8");
if (!runbookText.includes("must not retrain A/B/C") || !runbookText.includes("open fresh Y") || !runbookText.includes("open Q6")) {
  throw new Error("WORKBUDDY_HANDOFF_SCOPE_MISMATCH");
}
const currentCopies = [
  ["EVO_ENGINEERING_FIRST_BUDGET100_V1_20260912.json", amendment.contentHash],
  ["EVO_ENGINEERING_MODEL_SELECTION_RULE_V1.json", rule.contentHash],
  ["EVO_T2_TRIGGER_FREEZE.json", t2.contentHash],
  ["EVO_FRESH13_PREFIX_FREEZE.json", prefix.contentHash],
  ["EVO_BUDGET100_STAGE_COST_TABLE.json", costs.contentHash],
  ["EVO_ENGINEERING_FIRST_BUDGET100_LEDGER.json", ledger.contentHash],
] as const;
for (const [name, expectedHash] of currentCopies) {
  const value = JSON.parse(await readFile(path.join(currentFormal, name), "utf8")) as Json;
  const body = { ...value };
  delete body.contentHash;
  if (value.contentHash !== expectedHash || hashCanonical(body) !== expectedHash) throw new Error(`CURRENT_FORMAL_COPY_MISMATCH:${name}`);
}
const amendmentMarkdown = await readFile(path.join(currentFormal, "EVO_ENGINEERING_FIRST_BUDGET100_V1_20260912.md"), "utf8");
if (!amendmentMarkdown.includes("after Initial-6") || !amendmentMarkdown.includes("before d6/d3 T1 causal Y")) {
  throw new Error("AMENDMENT_TIMING_TEXT_MISMATCH");
}
const implementationFiles = {
  engineeringModuleSha256: "src/evaluation/direction-a/formal/modeling/evo-engineering-first.ts",
  engineeringTestSha256: "src/evaluation/direction-a/formal/modeling/evo-engineering-first.test.ts",
  freezeScriptSha256: "scripts/direction-a/formal/evo-engineering-first-freeze.ts",
  verifyScriptSha256: "scripts/direction-a/formal/evo-engineering-first-verify.ts",
} as const;
for (const [binding, relativePath] of Object.entries(implementationFiles)) {
  if (sha(await readFile(path.join(memoryCore, relativePath))) !== authorization.requiredBindings[binding]) {
    throw new Error(`IMPLEMENTATION_BINDING_MISMATCH:${binding}`);
  }
}
process.stdout.write("EVO_ENGINEERING_FIRST_FOCUSED_VERIFICATION_PASS\nNEW_PROVIDER_CALLS=0\nNEW_MODEL_CALLS=0\nSECRET_READS=0\nNEXT=READY_FOR_EVO_ENGINEERING_FIRST_T1_AUTHORIZATION\n");
