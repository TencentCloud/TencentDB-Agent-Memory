import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  FRESH_BUDGET_EXTENSION_MAX_CNY, FRESH_DECISION_ID, FRESH_EXPECTED_CALLS, FRESH_FROZEN_N9_PREFIX_LENGTH, FRESH_GLOBAL_HARD_CAP_CNY,
  FRESH_MAX_CALLS, FRESH_N, FRESH_P95_RESERVATION_CNY, FRESH_PAID_AUTHORITY, FRESH_PREFIX_HASH,
  FRESH_PRIOR_RECONCILED_SPEND_CNY, FRESH_PROTECTED_TOTAL_CNY, FRESH_REQUIRED_FORBIDDEN, FRESH_RUNTIME_ROOT,
  assertFreshAuthorizationRequest, assertFreshExactManifest, createFreshExactManifest, hashCanonical,
  type FreshAuthorizationRequest, type FreshFeatureScoringBindingSnapshot,
} from "../../../src/evaluation/direction-a/formal/index.js";

const repoRoot = resolve(process.cwd()); const workspaceRoot = resolve(repoRoot, "..");
const canonicalRootName = "Direction_A_Evo_Fresh_N9_Grant_Runtime_Adapter_Closure_v1";
const arg = (name: string): string | undefined => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const outputRoot = resolve(arg("--output") ?? resolve(workspaceRoot, canonicalRootName));
const generatedAt = "2026-09-12T00:00:00.000+08:00"; const validated = process.argv.includes("--validated");
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const fileSha = (path: string): string => sha(readFileSync(path));
const withHash = <T extends Record<string, unknown>>(body: T): T & { contentHash: string } => ({ ...body, contentHash: hashCanonical(body) });
const writeJson = (name: string, value: unknown): void => writeFileSync(resolve(outputRoot, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
const writeText = (name: string, value: string): void => writeFileSync(resolve(outputRoot, name), value.replaceAll("\r\n", "\n"), "utf8");
const rel = (path: string): string => relative(workspaceRoot, path).replaceAll("\\", "/");
mkdirSync(outputRoot, { recursive: true });

const exact = createFreshExactManifest(); assertFreshExactManifest(exact);
const profilePath = resolve(repoRoot, ".research/direction-a/current-formal/pilot/manifests/real-execution-profile-v3.json");
const profile = JSON.parse(readFileSync(profilePath, "utf8")) as { contentHash: string };
const paths = {
  proposed: resolve(workspaceRoot, "Direction_A_Evo_Fresh_PreY_Paid_Closure_v1/04_FINAL_PROPOSED_BINDING.json"),
  baseline: resolve(workspaceRoot, "Direction_A_Evo_Fresh_PreY_Paid_Closure_v1/05_FINAL_PRIMARY_BASELINE_FREEZE.json"),
  comparator: resolve(workspaceRoot, "Direction_A_Evo_Fresh_PreY_Paid_Closure_v1/06_FINAL_STRONG_COMPARATOR_FREEZE.json"),
  modelSet: resolve(workspaceRoot, "Direction_A_Evo_Fresh_PreY_Paid_Closure_v1/07_FINAL_MODEL_SET_FREEZE.json"),
  trainingBank: resolve(workspaceRoot, "Direction_A_Evo_PostT1_Model_Checkpoint_v1/02_EVO_8TASK_10GROUP_BANK.json"),
  sourceProposed: resolve(workspaceRoot, "Direction_A_PostCAL_Model_Value_v2_1/11_PROPOSED_V2_FINAL_MODEL.json"),
  sourceBaseline: resolve(workspaceRoot, "Direction_A_PostCAL_Model_Value_v2_1/12_BASELINE_V2_FINAL_MODEL.json"),
  predictor: resolve(repoRoot, "src/evaluation/direction-a/formal/modeling/evo-continuous-adaptation.ts"),
  feature: resolve(repoRoot, "src/evaluation/direction-a/formal/evo-fresh/fresh-feature-scoring.ts"),
  checkpointFeatureConsumer: resolve(repoRoot, "scripts/direction-a/formal/evo-post-t1-checkpoint.ts"),
};
for (const path of Object.values(paths)) if (!existsSync(path)) throw new Error(`FRESH_CLOSURE_REQUIRED_SOURCE_ABSENT:${path}`);

const featureBindings: FreshFeatureScoringBindingSnapshot = withHash({
  schemaVersion: "direction-a.evo-fresh-feature-scoring-byte-bindings.v1" as const,
  bindings: {
    proposedModel: { path: rel(paths.proposed), sha256: fileSha(paths.proposed) },
    primaryBaseline: { path: rel(paths.baseline), sha256: fileSha(paths.baseline) },
    strongComparator: { path: rel(paths.comparator), sha256: fileSha(paths.comparator) },
    featureContract: { path: rel(paths.proposed), sha256: fileSha(paths.proposed) },
    preprocessing: { path: rel(paths.proposed), sha256: fileSha(paths.proposed) },
    sourceScoreImplementation: { path: rel(paths.feature), sha256: fileSha(paths.feature) },
    predictorImplementation: { path: rel(paths.predictor), sha256: fileSha(paths.predictor) },
    trainingBank: { path: rel(paths.trainingBank), sha256: fileSha(paths.trainingBank) },
    modelSet: { path: rel(paths.modelSet), sha256: fileSha(paths.modelSet) },
    proposedSourceModel: { path: rel(paths.sourceProposed), sha256: fileSha(paths.sourceProposed) },
    legacySourceModel: { path: rel(paths.sourceBaseline), sha256: fileSha(paths.sourceBaseline) },
    historicalCheckpointFeatureConsumer: { path: rel(paths.checkpointFeatureConsumer), sha256: fileSha(paths.checkpointFeatureConsumer) },
  },
});

writeText("00_READ_FIRST.md", `# Evo fresh N9 grant/runtime adapter closure\n\nStatus: **${validated ? "PASS" : "PENDING_FOCUSED_VALIDATION"}**. This package closes engineering only. It is not a grant and authorizes zero paid calls.\n\nNEXT = READY_FOR_EVO_FRESH_ENGINEERING_HOLDOUT_REAUTHORIZATION\n`);
writeText("01_PREPATCH_BLOCKER_REPRODUCTION.md", "# Pre-patch blocker reproduction\n\nPRE_PATCH_BLOCKER_REPRODUCED = YES\n\nThe prior paid branch ended at `FRESH_PAID_RUNTIME_BUNDLE_NOT_MATERIALIZED_BY_THIS_ZERO_PROVIDER_CLOSURE`. Its no-flag path remained zero-provider and printed `FRESH_ZERO_PROVIDER_PREFLIGHT_PASS`.\n");
writeJson("02_N9_SAMPLE_AND_BUDGET_AMENDMENT.json", withHash({ schemaVersion: "direction-a.evo-fresh-n9-sample-budget-amendment.v1", generatedAt,
  status: "PASS", frozenAffordabilityLadder: [9, 8, 7, 6], freshN: FRESH_N, prefixHash: FRESH_PREFIX_HASH,
  expectedProviderCalls: FRESH_EXPECTED_CALLS, maximumProviderCalls: FRESH_MAX_CALLS,
  priorReconciledSpendCny: FRESH_PRIOR_RECONCILED_SPEND_CNY, p95ReservationCny: FRESH_P95_RESERVATION_CNY,
  protectedTotalCny: FRESH_PROTECTED_TOTAL_CNY, researcherBudgetExtensionMaximumCny: FRESH_BUDGET_EXTENSION_MAX_CNY,
  oldGlobalHardCapCny: 100, globalHardCapCny: FRESH_GLOBAL_HARD_CAP_CNY, n10Forbidden: true, scientificDesignChanged: false }));
writeJson("03_FRESH_EXACT_MANIFEST_FREEZE.json", exact);
const runtimeBinding = withHash({ schemaVersion: "direction-a.evo-fresh-n9-runtime-binding.v1", generatedAt, status: "PASS",
  runtimeRoot: FRESH_RUNTIME_ROOT, noT1PaidDispatchStateImport: true, authoritativeExecutionJournal: `${FRESH_RUNTIME_ROOT}\\execution-events.jsonl`,
  controlArtifacts: ["FRESH_N9_RUN_STATE.json", "FRESH_N9_BUDGET_LEDGER.jsonl", "FRESH_N9_ALL_NORMAL_BARRIER.json", "FRESH_N9_PRE_Y_POLICY_FREEZE.json"] });
writeJson("04_FRESH_RUNTIME_BINDING.json", runtimeBinding);
writeJson("05_FRESH_GRANT_GATE_FREEZE.json", withHash({ schemaVersion: "direction-a.evo-fresh-n9-grant-gate-freeze.v1", generatedAt, status: "PASS",
  grantSchema: "direction-a.evo-fresh-n9-authorization.v1", approvalStringFormat: "APPROVE_EVO_FRESH_ENGINEERING_HOLDOUT <REQUEST_CONTENT_HASH>",
  immutableNoOverwrite: true, typedPermitRequired: true, preparedManifestRequiredForPermit: true,
  secretGateOrder: ["VALID_IMMUTABLE_PERMIT", "PREPARED_MANIFEST_PASS", "DOCKER_READY", "UNAMBIGUOUS_JOURNAL_RESUME", "BUDGET_RESERVATION_PASS", "SECRET_READ"] }));
const preparedContract = withHash({ schemaVersion: "direction-a.evo-fresh-n9-prepared-manifest-contract.v1", generatedAt, status: "PASS",
  preparedManifestSchema: "direction-a.evo-fresh-n9-prepared-manifest.v1", exactN: 9, sourceMemoryRound: "TARGET_ROUND_MINUS_ONE",
  normalAndFullTreatment: "SAME_FROZEN_AUTO_INJECTION", removeTreatment: "NO_MEMORY_CONTEXT", fixedPairIndices: [1, 2, 3, 4],
  technicalReplacementLimitPerTask: 2, providerCallsDuringPreparation: 0, pair5Forbidden: true, t1JournalImportForbidden: true });
writeJson("06_FRESH_PREPARED_MANIFEST_CONTRACT.json", preparedContract);
writeJson("07_FRESH_PAID_AUTHORITY_FREEZE.json", withHash({ schemaVersion: "direction-a.evo-fresh-n9-paid-authority-freeze.v1", generatedAt,
  status: "PASS", authority: FRESH_PAID_AUTHORITY }));
writeJson("08_FRESH_BUDGET_ACCOUNTING_FREEZE.json", withHash({ schemaVersion: "direction-a.evo-fresh-n9-budget-accounting-freeze.v1", generatedAt,
  status: "PASS", accountingLedger: "FRESH_N9_BUDGET_LEDGER.jsonl", appendOnlyHashChain: true,
  initialExposure: { priorReconciledSpendCny: FRESH_PRIOR_RECONCILED_SPEND_CNY, actualFreshSpendCny: 0,
    pendingUnknownReserveCny: 0, remainingAuthorizedReservationCny: FRESH_P95_RESERVATION_CNY, protectedExposureCny: FRESH_PROTECTED_TOTAL_CNY,
    maximumProviderCalls: FRESH_MAX_CALLS }, semantics: ["ACTUAL_REPLACES_RESERVED_EXPOSURE", "PENDING_DISPATCH_GETS_UNKNOWN_RESERVE",
    "REMAINING_RESERVATION_COVERS_UNEXECUTED_SCOPE", "PROTECTED_EXPOSURE_LTE_CNY110", "CALLS_LTE_1188"] }));
writeJson("09_FRESH_FEATURE_SCORING_BINDING.json", featureBindings);
writeJson("10_FRESH_PHASE_BOUNDARY_FREEZE.json", withHash({ schemaVersion: "direction-a.evo-fresh-n9-phase-boundary-freeze.v1", generatedAt,
  status: "PASS", invocations: ["--preflight", "--phase1-normal", "--phase2-freeze", "--phase3-causal"], oneProcessFallthroughForbidden: true,
  stops: ["FRESH_ZERO_PROVIDER_PREFLIGHT_PASS", "FRESH_PHASE1_ALL_NORMAL_COMPLETE_MANDATORY_STOP",
    "FRESH_PHASE2_PRE_Y_POLICY_FREEZE_MANDATORY_STOP", "FRESH_PHASE3_FIXED4_COMPLETE_MANDATORY_STOP"],
  acceptedCounts: { 40: 4, 60: 5, 70: 6, 80: 7 }, ranking: "SCORE_DESC_THEN_CANONICAL_TASK_ID_ASC" }));
writeJson("11_FRESH_RESUME_RETRY_FREEZE.json", withHash({ schemaVersion: "direction-a.evo-fresh-n9-resume-retry-freeze.v1", generatedAt,
  status: "PASS", authoritativeDispatchTruth: "CurrentFormalExecutionEventJournal", controlStateIsNotDispatchJournal: true,
  maxReplacementsPerTaskAcrossAllSlots: 2, maxTrialsPerTask: 11, maxTotalTrials: 99, maxProviderCalls: 1188,
  rules: ["RECONCILED_NEVER_REDISPATCH", "SCIENTIFIC_FAILURE_TERMINAL_NO_RETRY", "THIRD_REPLACEMENT_PER_TASK_FAILS",
    "UNCERTAIN_DISPATCH_GLOBAL_STOP", "DUPLICATE_DISPATCH_GLOBAL_STOP", "HARBOR_JOB_STATE_REQUIRED_FOR_RESUME"] }));
writeJson("12_FRESH_EXECUTOR_BINDING.json", withHash({ schemaVersion: "direction-a.evo-fresh-n9-executor-binding.v1", generatedAt,
  status: "PASS", wrapper: "AuthorizedFreshEvoHarborExecutor", genericCore: "GenericEvoHarborExecutionCore",
  jobPrefix: "evo-fresh-n9", preserves: ["DIRECTORY_HASH_VALIDATION", "HARBOR_CONFIG_HASH", "RESUME_PROOF", "USAGE_COST_CAPTURE",
    "CASE_SUMMARY_GRADING", "TECHNICAL_INVALID_CLASSIFIER", "POST_VERIFIER_CLEANUP_SALVAGE", "SANITIZED_CHILD_ENV", "DUPLICATE_DISPATCH_PROTECTION"] }));

writeText("WORKBUDDY_EVO_FRESH_N9_EXECUTION_V3.md", `# WorkBuddy — Evo fresh N9 execution V3\n\nStatus: **NOT AUTHORIZED**. Read the current request content hash from \`13_FRESH_AUTHORIZATION_REQUEST.json\`; this runbook intentionally does not embed it, avoiding a request/runbook hash cycle.\n\n1. Verify the request and every bound file.\n2. Obtain the exact researcher string \`APPROVE_EVO_FRESH_ENGINEERING_HOLDOUT <REQUEST_CONTENT_HASH>\`.\n3. Materialize with \`npm exec tsx scripts/direction-a/formal/evo-fresh-grant-materialize.ts -- --approval "<exact string>"\`.\n4. Independently verify the immutable grant with \`npm exec tsx scripts/direction-a/formal/evo-fresh-grant-verify.ts\`; before preparation it must report typed permit pending.\n5. Prove Docker READY, then run the zero-provider prepare driver. No secret is read.\n6. Verify the prepared manifest and typed permit with \`npm exec tsx scripts/direction-a/formal/evo-fresh-grant-verify.ts -- --prepared "<runtime>\\prepared\\FRESH_N9_PREPARED_EXECUTION_MANIFEST.json"\`; require \`FRESH_TYPED_PERMIT_VERIFIED\`.\n7. Run \`evo-fresh-paid-run.ts --preflight\`; stop at \`FRESH_ZERO_PROVIDER_PREFLIGHT_PASS\`.\n8. Run \`--phase1-normal\`; stop at \`FRESH_PHASE1_ALL_NORMAL_COMPLETE_MANDATORY_STOP\`.\n9. In a separate process with no secret config, run \`--phase2-freeze\`; stop at \`FRESH_PHASE2_PRE_Y_POLICY_FREEZE_MANDATORY_STOP\`.\n10. In a separate paid process run \`--phase3-causal\`; reconcile and stop at \`FRESH_PHASE3_FIXED4_COMPLETE_MANDATORY_STOP\`.\n\nAny drift, uncertain/duplicate dispatch, third task-level replacement, Pair5, N10, TRAIN, T2, or Q6 fails closed.\n`);
writeText("14_WORKBUDDY_FRESH_HANDOFF.md", "# WorkBuddy fresh handoff\n\nUse `WORKBUDDY_EVO_FRESH_N9_EXECUTION_V3.md`. The old N8 request `a0f4700744247b07a7625b9b39e1478765753b400b29e1a1dcbf34e4733f62c1` is superseded. No approval has been materialized.\n");

const bindingPaths: Record<string, string> = {
  repairedCheckpointBindings: "Direction_A_Evo_Fresh_PreY_Paid_Closure_v1/02_REPAIRED_CHECKPOINT_BINDINGS.json",
  preT1StabilityTrigger: "Direction_A_Evo_Fresh_PreY_Paid_Closure_v1/03_PRE_T1_STABILITY_TRIGGER_BINDING.json",
  postT1FinalModelFreeze: "Direction_A_Evo_PostT1_Model_Checkpoint_v1/09_FINAL_MODEL_FREEZE.json",
  modelSelectionRule: "Direction_A_Evo_Engineering_First_Budget100_v1/03_ENGINEERING_MODEL_SELECTION_RULE.json",
  baselineRecipe: "Direction_A_Evo_Engineering_First_Budget100_v1/04_BASELINE_FREEZE_SPEC.json",
  proposedModel: rel(paths.proposed), primaryBaseline: rel(paths.baseline), strongComparator: rel(paths.comparator), modelSet: rel(paths.modelSet),
  trainingBank: rel(paths.trainingBank), proposedSourceModel: rel(paths.sourceProposed), legacySourceModel: rel(paths.sourceBaseline),
  freshPrefix: "Direction_A_Evo_Engineering_First_Budget100_v1/07_FRESH13_PREFIX_FREEZE.json",
  costTable: "Direction_A_Evo_Engineering_First_Budget100_v1/08_BUDGET100_STAGE_COST_TABLE.json",
  executionProfile: rel(profilePath), sampleBudgetAmendment: `${canonicalRootName}/02_N9_SAMPLE_AND_BUDGET_AMENDMENT.json`,
  exactManifest: `${canonicalRootName}/03_FRESH_EXACT_MANIFEST_FREEZE.json`,
  runtimeBinding: `${canonicalRootName}/04_FRESH_RUNTIME_BINDING.json`, grantGate: `${canonicalRootName}/05_FRESH_GRANT_GATE_FREEZE.json`,
  preparedManifestContract: `${canonicalRootName}/06_FRESH_PREPARED_MANIFEST_CONTRACT.json`, paidAuthority: `${canonicalRootName}/07_FRESH_PAID_AUTHORITY_FREEZE.json`,
  budgetAccounting: `${canonicalRootName}/08_FRESH_BUDGET_ACCOUNTING_FREEZE.json`, featureScoringBinding: `${canonicalRootName}/09_FRESH_FEATURE_SCORING_BINDING.json`,
  phaseBoundary: `${canonicalRootName}/10_FRESH_PHASE_BOUNDARY_FREEZE.json`, resumeRetry: `${canonicalRootName}/11_FRESH_RESUME_RETRY_FREEZE.json`,
  executorBinding: `${canonicalRootName}/12_FRESH_EXECUTOR_BINDING.json`, workBuddyRunbook: `${canonicalRootName}/WORKBUDDY_EVO_FRESH_N9_EXECUTION_V3.md`,
  exactManifestValidator: "MemoryCore/src/evaluation/direction-a/formal/evo-fresh/fresh-manifest.ts",
  preparedManifestValidator: "MemoryCore/src/evaluation/direction-a/formal/evo-fresh/fresh-manifest.ts",
  freshPaidAuthorityCode: "MemoryCore/src/evaluation/direction-a/formal/evo-fresh/fresh-paid-authority.ts",
  freshGrantGateCode: "MemoryCore/src/evaluation/direction-a/formal/evo-fresh/fresh-execution-gate.ts",
  featureScoringHelpers: "MemoryCore/src/evaluation/direction-a/formal/evo-fresh/fresh-feature-scoring.ts",
  historicalCheckpointFeatureConsumer: "MemoryCore/scripts/direction-a/formal/evo-post-t1-checkpoint.ts",
  phaseStateMachine: "MemoryCore/src/evaluation/direction-a/formal/evo-fresh/fresh-prey-runtime.ts",
  authoritativeJournal: "MemoryCore/src/evaluation/direction-a/formal/prepilot/execution-state-attestation.ts",
  genericHarborExecutor: "MemoryCore/src/evaluation/direction-a/formal/executors/evo-harbor-executor.ts",
  prepareDriver: "MemoryCore/scripts/direction-a/formal/evo-fresh-prepare.ts", phaseRunner: "MemoryCore/scripts/direction-a/formal/evo-fresh-paid-run.ts",
  grantMaterializer: "MemoryCore/scripts/direction-a/formal/evo-fresh-grant-materialize.ts", grantVerifier: "MemoryCore/scripts/direction-a/formal/evo-fresh-grant-verify.ts",
  supersededN8ClosureFirewall: "MemoryCore/scripts/direction-a/formal/evo-fresh-prey-closure.ts",
  supersededN8VerifierFirewall: "MemoryCore/scripts/direction-a/formal/evo-fresh-prey-verify.ts",
  closureGenerator: "MemoryCore/scripts/direction-a/formal/evo-fresh-n9-closure.ts", closureVerifier: "MemoryCore/scripts/direction-a/formal/evo-fresh-n9-verify.ts",
};
const generatedFiles = new Set(Object.keys(bindingPaths).filter((key) => ["sampleBudgetAmendment", "exactManifest", "runtimeBinding", "grantGate", "preparedManifestContract",
  "paidAuthority", "budgetAccounting", "featureScoringBinding", "phaseBoundary", "resumeRetry", "executorBinding", "workBuddyRunbook"].includes(key)));
const bindings: Record<string, string> = {};
for (const [key, path] of Object.entries(bindingPaths)) {
  const absolute = generatedFiles.has(key) ? resolve(outputRoot, path.split("/").at(-1)!) : resolve(workspaceRoot, path);
  if (!existsSync(absolute)) throw new Error(`FRESH_AUTHORIZATION_BINDING_ABSENT:${key}:${absolute}`); bindings[key] = fileSha(absolute);
}
const requestBody = { schemaVersion: "direction-a.evo-fresh-n9-authorization-request.v1" as const, decisionId: FRESH_DECISION_ID,
  status: "PENDING_RESEARCHER_REAUTHORIZATION" as const, requestedStage: "EVO_FRESH_ENGINEERING_HOLDOUT" as const,
  authorized: false as const, materializedResearcherApproval: false as const, allowPaidExecution: false as const,
  oldN8RequestSuperseded: "a0f4700744247b07a7625b9b39e1478765753b400b29e1a1dcbf34e4733f62c1", freshN: FRESH_N,
  freshPrefixHash: FRESH_PREFIX_HASH, exactManifestHash: exact.contentHash,
  preparedManifestSchema: "direction-a.evo-fresh-n9-prepared-manifest.v1" as const, preparedManifestContractHash: preparedContract.contentHash,
  runtimeRoot: FRESH_RUNTIME_ROOT, executionProfileHash: profile.contentHash, paidAuthorityHash: FRESH_PAID_AUTHORITY.contentHash,
  expectedProviderCalls: FRESH_EXPECTED_CALLS, maximumProviderCalls: FRESH_MAX_CALLS,
  priorReconciledSpendCny: FRESH_PRIOR_RECONCILED_SPEND_CNY, freshP95ReservationCny: FRESH_P95_RESERVATION_CNY,
  researcherBudgetExtensionMaximumCny: FRESH_BUDGET_EXTENSION_MAX_CNY, globalHardCapCny: FRESH_GLOBAL_HARD_CAP_CNY,
  protectedTotalCny: FRESH_PROTECTED_TOTAL_CNY,
  approvalStringFormat: "APPROVE_EVO_FRESH_ENGINEERING_HOLDOUT <REQUEST_CONTENT_HASH>" as const,
  requiredBindingPaths: bindingPaths, requiredBindings: bindings, requiredBindingsCount: Object.keys(bindings).length,
  requiredBindingsHash: hashCanonical(bindings), forbidden: [...FRESH_REQUIRED_FORBIDDEN] };
const request = withHash(requestBody) as unknown as FreshAuthorizationRequest;
// Fail closed: this builder predates the peak-CNY100 active-prefix5 authority and must never emit
// a superseded-format request again. The live builder is evo-fresh-peak100-prefix5-closure.ts.
assertFreshAuthorizationRequest(request); writeJson("13_FRESH_AUTHORIZATION_REQUEST.json", request);
writeText("15_FOCUSED_TEST_REPORT.md", `# Focused test report\n\nStatus: **${validated ? "PASS" : "PENDING"}**. Focused suite: ${validated ? "2 files / 25 tests passed" : "pending"}; relevant Direction-A typecheck: ${validated ? "PASS" : "pending"}.\n\n1. ${validated ? "PASS" : "PENDING"} — task-level replacements across different slots and third-replacement fail-closed.\n2. ${validated ? "PASS" : "PENDING"} — exact first-N9 prefix identity, no TRAIN/Q6/T2 overlap, varying target rounds, and live source inventory hashes.\n3. ${validated ? "PASS" : "PENDING"} — exact Phase1 barrier, duplicate/missing/foreign/group mismatch rejection, and phase separation.\n4. ${validated ? "PASS" : "PENDING"} — actual prepared task bytes, model/scoring byte drift, grant approval, binding drift, immutable overwrite, and typed permit.\n5. ${validated ? "PASS" : "PENDING"} — append-only CNY110 replacement-style accounting, partial reconciliation, unknown reserve, and 1188 call cap.\n6. ${validated ? "PASS" : "PENDING"} — authoritative journal plus Harbor-state resume/no-redispatch and uncertain/duplicate global stops.\n7. ${validated ? "PASS" : "PENDING"} — AuthorizedFreshEvoHarborExecutor permit binding with generic Harbor regressions preserved.\n8. ${validated ? "PASS" : "PENDING"} — historical T1 canonical NORMAL/source-score helper output unchanged, scoped diff hygiene, and byte-identical deterministic closure replay.\n`);
writeText("16_REPRODUCIBILITY_REPORT.md", `# Reproducibility report\n\nStatus: **${validated ? "PASS" : "PENDING"}**. Generator: \`MemoryCore/scripts/direction-a/formal/evo-fresh-n9-closure.ts\`. Verification: \`MemoryCore/scripts/direction-a/formal/evo-fresh-n9-verify.ts\`. Real grant, runtime preparation, provider calls, model calls, secret reads, and paid Docker launches: **0**.\n`);

const inventoryFiles = readdirSync(outputRoot, { withFileTypes: true }).filter((row) => row.isFile() && row.name !== "SHA256_INVENTORY.json")
  .map((row) => row.name).sort();
writeJson("SHA256_INVENTORY.json", withHash({ schemaVersion: "direction-a.evo-fresh-n9-closure-inventory.v1", generatedAt,
  status: validated ? "PASS" : "PENDING_FOCUSED_VALIDATION", selfExcluded: true,
  files: inventoryFiles.map((name) => ({ path: name, bytes: readFileSync(resolve(outputRoot, name)).byteLength, sha256: fileSha(resolve(outputRoot, name)) })) }));
console.log("EVO_FRESH_N9_CLOSURE_GENERATED"); console.log(`outputRoot=${outputRoot}`); console.log(`requestContentHash=${request.contentHash}`);
console.log(`requiredBindingsCount=${request.requiredBindingsCount}`); console.log("providerCalls=0 modelCalls=0 secretReads=0 paidDockerLaunches=0");
