/**
 * Deterministic zero-provider builder for the FINAL Fresh recovery closure.
 *
 * Fixes the three engineering blockers in one pass:
 *   F1  every hash the request binds comes from a real, on-disk artifact written right here
 *       (exact manifest, denominator restriction, fail-fast normalization spec, prepared-manifest
 *       contract, prefix-environment manifest, rolling-reserve telemetry, n3 recovery semantics).
 *   F2  the full transitive defense-in-depth binding closure is restored mechanically (no manual
 *       pruning) and extended with this round's recovery artifacts and phase runner.
 *   F3  the phase runner (`evo-fresh-paid-run.ts`) is part of the bound paid path.
 *
 * Budget is telemetry only: no reservation, rolling reserve, projection or cap can fail-close a run.
 *
 * No provider/model call, no paid Agent dispatch, no secret read, no Docker launch.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { canonicalJson, hashCanonical } from "../../../src/evaluation/direction-a/formal/core/canonical.js";
import { assertRealExecutionProfile, type RealExecutionProfile } from "../../../src/evaluation/direction-a/formal/acquisition/execution-profile.js";
import { collectPromotedFreshFeatureScoringBindings } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-binding-verification.js";
import { assertFreshAuthorizationRequest, FRESH_REQUIRED_FORBIDDEN,
  type FreshAuthorizationRequest } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-execution-gate.js";
import type { FreshFeatureScoringBindingSnapshot } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-feature-scoring.js";
import { buildFreshLocalDependencyClosure, type FreshClosureRoot } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-transitive-bindings.js";
import { assertFreshDenominatorQualification, normalizeFailFastCaseAccountingVerifier,
  FRESH_DENOMINATOR_ACTIVE_PREFIX_SCOPE, FRESH_DENOMINATOR_PROTOCOL_VERSION,
  type FreshDenominatorQualification } from "../../../src/evaluation/direction-a/formal/evo-fresh/failfast-case-accounting.js";
import { createFreshExactManifest, assertFreshExactManifest, FRESH_ACTIVE_PREFIX_TASK_HASH, FRESH_ACTIVE_TASKS,
  FRESH_DECISION_ID, FRESH_FORBIDDEN_TAIL_TASK_IDS, FRESH_FROZEN_N9_TASK_IDS,
  FRESH_GROUP_IDS, FRESH_N, FRESH_PREFIX_HASH, FRESH_RUNTIME_ROOT, FRESH_TASK_IDS,
  type FreshExactManifest } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-manifest.js";
import { createN3PrefixEnvironmentManifest, assertN3PrefixEnvironmentManifest, N3_PREFIX_ENVIRONMENT_ARTIFACT_PATH,
  N3_PREFIX_ENVIRONMENT_ATTEMPT_ID, N3_PREFIX_ENVIRONMENT_RECOVERY_ID, N3_PREFIX_ENVIRONMENT_TASK_ID,
  N3_PREFIX_ENVIRONMENT_TASK_PREFIX_INDEX } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-prefix-environment-recovery.js";
import { FRESH_ABSOLUTE_ACCOUNTING_CEILING_CNY, FRESH_ACTIVE_PREFIX_N, FRESH_BUDGET_IS_TELEMETRY_ONLY,
  FRESH_CONSERVATIVE_WHOLE_TASK_RESERVE_CNY, FRESH_EXPECTED_CALLS, FRESH_FROZEN_N9_PREFIX_LENGTH, FRESH_HISTORICAL_FRESH_SPEND_CNY,
  FRESH_INCREMENTAL_BUDGET_CAP_CNY, FRESH_MAX_ATTEMPTS_PER_TASK, FRESH_MAX_CALLS, FRESH_MAX_TURNS_PER_TRIAL,
  FRESH_PAID_AUTHORITY, FRESH_PEAK_PROTECTED_RESERVATION_CNY, FRESH_PEAK_RATES_CNY_PER_MILLION_TOKENS,
  FRESH_PROTECTED_TOTAL_CNY, FRESH_REMAINING_FRESH_BUDGET_CNY } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-paid-authority.js";

type Json = Record<string, any>;
const GENERATED_AT = "2026-09-14T00:00:00.000+08:00";
const repoRoot = resolve(process.cwd()); const workspaceRoot = resolve(repoRoot, "..");
const outputRoot = resolve(workspaceRoot, "Direction_A_Evo_Fresh_FinalRecovery_Closure_v1");
const postT1Root = resolve(workspaceRoot, "Direction_A_Evo_PostT1_Requalification_Closure_v2");
const failFastRoot = resolve(workspaceRoot, "Direction_A_Evo_Fresh_FailFast_Measurement_Closure_v1");
const peak100Root = resolve(workspaceRoot, "Direction_A_Evo_Fresh_Peak100_Prefix5_Closure_v1");
const codexRecoveryRoot = resolve(workspaceRoot, "Direction_A_Evo_Fresh_PrefixEnv_BudgetRecovery_Closure_v1");
const transitiveV2Root = resolve(workspaceRoot, "Direction_A_Evo_Fresh_Transitive_Binding_Closure_v2");
const checkOnly = process.argv.includes("--check");
const refresh = process.argv.includes("--refresh");

const documents = new Map<string, Buffer>();
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const slash = (value: string): string => value.replaceAll("\\", "/");
const stable = (value: unknown): Buffer => Buffer.from(`${canonicalJson(value)}\n`);
const seal = <T extends Json>(body: T): T & { contentHash: string } => ({ ...body, contentHash: hashCanonical(body) });
const addJson = (name: string, body: Json): Json => {
  // Never re-seal a document that already carries its own content hash (double sealing would store
  // a hash of the hash and break request verification).
  const document = typeof body.contentHash === "string" ? body : seal(body);
  documents.set(name, stable(document)); return document;
};
const addText = (name: string, value: string): void => { documents.set(name, Buffer.from(value.replaceAll("\r\n", "\n"))); };
const setBytes = (name: string, bytes: Buffer): void => { documents.set(name, bytes); };
const plannedSha = (name: string): string => { const bytes = documents.get(name); if (!bytes) throw new Error(`FRESH_PLANNED_ARTIFACT_MISSING:${name}`); return sha(bytes); };
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const workspacePath = (name: string): string => slash(relative(workspaceRoot, resolve(outputRoot, name)));

// ---------------------------------------------------------------------------------------------
// Roots of the paid path: everything that can move prepare / Phase1 / Phase2 / Phase3 / grading /
// retry / policy / pair-order / state is bound transitively from these entry points.
// ---------------------------------------------------------------------------------------------
const authorizationRoots: FreshClosureRoot[] = [
  { path: "MemoryCore/scripts/direction-a/formal/evo-fresh-final-recovery-closure.ts", role: "AUTHORIZATION_REQUEST_BUILDER", reason: "constructs this closure and all promoted request-level byte bindings" },
  { path: "MemoryCore/scripts/direction-a/formal/evo-fresh-final-recovery-preflight.ts", role: "ZERO_PROVIDER_PREFLIGHT", reason: "verifies every direct binding before authorization" },
  { path: "MemoryCore/scripts/direction-a/formal/evo-fresh-grant-materialize.ts", role: "GRANT_MATERIALIZER", reason: "constructs only an exact later-approved grant" },
  { path: "MemoryCore/scripts/direction-a/formal/evo-fresh-grant-verify.ts", role: "GRANT_VERIFIER", reason: "replays grant and request bindings" },
  { path: "MemoryCore/scripts/direction-a/formal/evo-fresh-denominator-qualify.ts", role: "FROZEN_N9_DENOMINATOR_QUALIFIER", reason: "authoritative producer of the frozen N9 structural denominators whose first five are reused" },
  { path: "MemoryCore/scripts/direction-a/formal/evo-fresh-failfast-validate.ts", role: "ANTI_CENSORING_VALIDATOR", reason: "proves complete n4 case accounting dynamically" },
  { path: "MemoryCore/scripts/direction-a/formal/evo-fresh-prefix-env-budget-recovery-preflight.ts", role: "RECOVERY_ZERO_PROVIDER_PREFLIGHT", reason: "previous recovery gate, kept in the bound authorization surface" },
];
const paidRoots: FreshClosureRoot[] = [
  { path: "MemoryCore/scripts/direction-a/formal/evo-fresh-transitive-binding-preflight.ts", role: "FULL_BINDING_PREFLIGHT", reason: "independent full-binding check over this request" },
  { path: "MemoryCore/scripts/direction-a/formal/evo-fresh-grant-materialize.ts", role: "GRANT_MATERIALIZER", reason: "later researcher-only grant boundary" },
  { path: "MemoryCore/scripts/direction-a/formal/evo-fresh-grant-verify.ts", role: "GRANT_VERIFIER", reason: "pre-prepare and post-prepare grant verification" },
  { path: "MemoryCore/scripts/direction-a/formal/evo-fresh-prepare.ts", role: "FRESH_PREPARE_ENTRYPOINT", reason: "prepares the exact active-prefix5 bytes and the hash-bound external prefix artifact" },
  { path: "MemoryCore/scripts/direction-a/formal/evo-fresh-paid-run.ts", role: "FRESH_PHASE_RUNNER", reason: "Phase1/Phase2/Phase3 runner with the n3 bounded prefix-environment recovery" },
  { path: "MemoryCore/.research/direction-a/current-formal/pilot/manifests/real-execution-profile-v3.json", role: "RUNTIME_CONFIG", reason: "frozen provider/model/execution profile" },
];

// ---------------------------------------------------------------------------------------------
// Cross-closure provenance (read-only)
// ---------------------------------------------------------------------------------------------
const priorRequests: Array<{ contentHash: string; path: string; fileSha256: string; status: string; reusable: boolean }> = [];
const recordPriorRequest = (path: string, absolute: string, status: string): void => {
  const bytes = readFileSync(absolute); const parsed = JSON.parse(bytes.toString("utf8")) as { contentHash: string };
  priorRequests.push({ contentHash: parsed.contentHash, path: slash(relative(workspaceRoot, absolute)), fileSha256: sha(bytes), status, reusable: false });
};
recordPriorRequest("postT1", resolve(postT1Root, "17_FRESH_AUTHORIZATION_REQUEST.json"), "SUPERSEDED");
recordPriorRequest("transitiveV2", resolve(transitiveV2Root, "08_NEW_FRESH_AUTHORIZATION_REQUEST.json"), "SUPERSEDED_PENDING_PHASE1_BYTE_BINDING_FIX");
recordPriorRequest("n9FailFast", resolve(failFastRoot, "10_NEW_FRESH_AUTHORIZATION_REQUEST.json"), "SUPERSEDED_BY_PEAK_BUDGET100_PREFIX_DECISION");
recordPriorRequest("peak100Prefix5", resolve(peak100Root, "10_NEW_FRESH_AUTHORIZATION_REQUEST.json"), "SUPERSEDED_BY_PREFIX_ENV_AND_TELEMETRY_RECOVERY");
recordPriorRequest("codexPrefixEnvRecovery", resolve(codexRecoveryRoot, "10_NEW_FRESH_AUTHORIZATION_REQUEST.json"), "SUPERSEDED_UNEXECUTABLE_BOUND_HASH_WITHOUT_ARTIFACT");
if (priorRequests.length !== 5 || new Set(priorRequests.map((row) => row.contentHash)).size !== 5) throw new Error("FRESH_PRIOR_REQUEST_PROVENANCE_INVALID");

const checkpoint = readJson<Json>(resolve(postT1Root, "10_POST_T1_MODEL_CHECKPOINT.json"));
if (checkpoint.checkpoint !== "STABLE" || checkpoint.winnerId !== "A_FROZEN_SOURCE_RESIDUAL_RIDGE") throw new Error("CORE_DECISION_REQUIRED_FRESH_STABLE_FAIL");
const frozenN9Qualification = readJson<FreshDenominatorQualification>(resolve(failFastRoot, "01_FRESH_N9_DENOMINATOR_QUALIFICATION.json"));
const frozenN9Exact = readJson<FreshExactManifest>(resolve(failFastRoot, "frozen/post-t1/FRESH_EXACT_MANIFEST_FREEZE.json"));
const antiCensoring = readJson<Json>(resolve(failFastRoot, "06_ANTI_CENSORING_REGRESSION.json"));
const profile = readJson<RealExecutionProfile>(resolve(repoRoot, ".research/direction-a/current-formal/pilot/manifests/real-execution-profile-v3.json"));
assertRealExecutionProfile(profile);
if (antiCensoring.providerCalls !== 0 || antiCensoring.modelCalls !== 0 || antiCensoring.genericRewardZeroMappingUsed !== false) throw new Error("FRESH_ANTI_CENSORING_PROOF_INVALID");
if (frozenN9Exact.tasks.length !== FRESH_FROZEN_N9_PREFIX_LENGTH
  || hashCanonical(frozenN9Exact.tasks.map((row) => row.taskId)) !== hashCanonical(FRESH_FROZEN_N9_TASK_IDS)
  || hashCanonical(frozenN9Exact.tasks.slice(0, FRESH_ACTIVE_PREFIX_N)) !== hashCanonical([...FRESH_ACTIVE_TASKS])) {
  throw new Error("FRESH_ACTIVE_PREFIX5_IS_NOT_FROZEN_N9_PREFIX_1_5");
}

// ---------------------------------------------------------------------------------------------
// F1: real on-disk artifacts for every hash the request binds
// ---------------------------------------------------------------------------------------------
const exact = createFreshExactManifest(); assertFreshExactManifest(exact);
addJson("02_ACTIVE_PREFIX5_EXACT_MANIFEST.json", exact as unknown as Json);

const restrictionEntries = frozenN9Qualification.entries.slice(0, FRESH_ACTIVE_PREFIX_N).map((entry) => structuredClone(entry));
if (restrictionEntries.length !== FRESH_ACTIVE_PREFIX_N || restrictionEntries.some((entry, index) => entry.prefixIndex !== index + 1
  || entry.taskId !== FRESH_ACTIVE_TASKS[index].taskId || entry.canonicalCausalGroupId !== FRESH_ACTIVE_TASKS[index].canonicalCausalGroupId
  || entry.targetRound !== FRESH_ACTIVE_TASKS[index].targetRound || entry.sourceTaskDirectoryHash !== FRESH_ACTIVE_TASKS[index].sourceTaskDirectoryHash)) {
  throw new Error("FRESH_PREFIX5_DENOMINATOR_RESTRICTION_IDENTITY_MISMATCH");
}
const restriction = addJson("03_ACTIVE_PREFIX5_DENOMINATOR_RESTRICTION.json", {
  schemaVersion: FRESH_DENOMINATOR_PROTOCOL_VERSION, generatedAt: GENERATED_AT, exactManifestHash: exact.contentHash,
  qualificationScope: FRESH_DENOMINATOR_ACTIVE_PREFIX_SCOPE, activePrefixN: FRESH_ACTIVE_PREFIX_N,
  derivedFromQualificationHash: frozenN9Qualification.contentHash, derivedFromQualificationEntryCount: FRESH_FROZEN_N9_PREFIX_LENGTH,
  oracleUse: "PRE_Y_STRUCTURAL_DENOMINATOR_ONLY", oracleBytesInAgentWorkspace: false, oracleOutputInCheapX: false,
  entries: restrictionEntries, providerCalls: 0, modelCalls: 0, paidAgentDispatches: 0, secretReads: 0,
  denominatorRequalificationPerformedThisRound: false,
});
assertFreshDenominatorQualification(restriction as unknown as FreshDenominatorQualification, exact);
const denominators = restrictionEntries.map((entry) => entry.qualifiedTotalCases);
if (hashCanonical(denominators) !== hashCanonical([62, 160, 111, 32, 323])) throw new Error("FRESH_PREFIX5_DENOMINATOR_VALUES_DRIFT");

const n4 = restrictionEntries[FRESH_ACTIVE_PREFIX_N - 2];
if (n4.prefixIndex !== 4 || n4.failFastNormalization?.version !== "direction-a.evo-fresh-failfast-case-accounting.v1") {
  throw new Error("FRESH_PREFIX5_N4_FAILFAST_CASE_ACCOUNTING_MISSING");
}
const n4NativeVerifier = readFileSync(resolve(repoRoot, `.research/direction-a/v6.3/dependencies/evocodebench_wotraj/${n4.taskId}/steps/round-${n4.targetRound}/tests/test.sh`), "utf8");
const n4Normalized = normalizeFailFastCaseAccountingVerifier(n4NativeVerifier);
if (n4Normalized.nativeVerifierSha256 !== n4.nativeVerifierSha256
  || n4Normalized.normalizedVerifierSha256 !== n4.failFastNormalization.normalizedVerifierSha256
  || n4Normalized.totalCases !== n4.qualifiedTotalCases) throw new Error("FRESH_PREFIX5_N4_NORMALIZATION_DRIFT");
const normalizationSpec = addJson("05_FAILFAST_NORMALIZATION_SPEC.json", {
  schemaVersion: "direction-a.evo-fresh-failfast-normalization-spec.v1", generatedAt: GENERATED_AT,
  denominatorProtocol: frozenN9Qualification.schemaVersion, activePrefix5QualificationHash: restriction.contentHash,
  frozenN9QualificationHash: frozenN9Qualification.contentHash, normalizationVersion: n4.failFastNormalization.version,
  nativeVerifierSha256: n4Normalized.nativeVerifierSha256, normalizedVerifierSha256: n4Normalized.normalizedVerifierSha256,
  registeredCaseCount: n4Normalized.totalCases, inventoryMutation: "FORBIDDEN", metric: "SUCCESS_COUNT_DIVIDED_BY_TOTAL_CASES",
  rewardZeroBinaryMapping: "FORBIDDEN", arms: ["NORMAL", "FULL", "REMOVE"],
  activePrefixCaseAccounting: "VERSIONED_COMPLETE_CASE_ACCOUNTING_WHERE_QUALIFIED",
  n8VerifierBytesOtherThanN4: "NATIVE_UNCHANGED", denominatorRequalificationPerformedThisRound: false,
});

const prefixEnvironment = createN3PrefixEnvironmentManifest(repoRoot);
assertN3PrefixEnvironmentManifest(repoRoot, prefixEnvironment);
addJson("06_N3_PREFIX_ENVIRONMENT_MANIFEST.json", prefixEnvironment as unknown as Json);

const preparedManifestContract = addJson("09_PREPARED_MANIFEST_CONTRACT.json", {
  schemaVersion: "direction-a.evo-fresh-n9-prepared-manifest.v3",
  prefixEnvironmentManifestHash: prefixEnvironment.contentHash, allowlistedExternalArtifact: N3_PREFIX_ENVIRONMENT_ARTIFACT_PATH,
  capture: "POST_PREFIX_CONTAINER_ALLOWLIST_HASH_BOUND", noHostSnapshot: true,
  requiresExternalPrefixArtifactForPrefixIndex: N3_PREFIX_ENVIRONMENT_TASK_PREFIX_INDEX,
});
const rollingReserve = addJson("07_ROLLING_WHOLE_TASK_RESERVE.json", {
  schemaVersion: "direction-a.evo-fresh.rolling-whole-task-reserve.v1", budgetMode: "OUTCOME_BLIND_ROLLING_WHOLE_TASK_RESERVE",
  budgetRole: "TELEMETRY_ONLY_NEVER_BLOCKS_EXECUTION", budgetNeverFailsClosed: FRESH_BUDGET_IS_TELEMETRY_ONLY,
  freshCapCny: FRESH_INCREMENTAL_BUDGET_CAP_CNY, historicalFreshSpendCny: FRESH_HISTORICAL_FRESH_SPEND_CNY,
  remainingFreshBudgetCny: FRESH_REMAINING_FRESH_BUDGET_CNY, conservativeWholeTaskReserveCny: FRESH_CONSERVATIVE_WHOLE_TASK_RESERVE_CNY,
  entryRule: "REPORT_ONLY_BEFORE_NEXT_COMPLETE_TASK_START", stoppingAuthority: "PROVIDER_REFUSAL_ONLY",
  prohibited: ["UPFRONT_ALL_REMAINING_TASK_RESERVATION", "OUTCOME_CONDITIONED_STOP", "BUDGET_DRIVEN_EARLY_STOP"],
});
const n3Recovery = addJson("08_N3_RECOVERY_SEMANTICS.json", {
  schemaVersion: "direction-a.evo-fresh.n3-recovery.v1", recoveryId: N3_PREFIX_ENVIRONMENT_RECOVERY_ID,
  taskId: N3_PREFIX_ENVIRONMENT_TASK_ID, taskPrefixIndex: N3_PREFIX_ENVIRONMENT_TASK_PREFIX_INDEX,
  recoveryAttemptId: N3_PREFIX_ENVIRONMENT_ATTEMPT_ID, oldAttempts: ["try-1", "try-2", "try-3"],
  oldAttemptDisposition: "INFRASTRUCTURE_TECHNICAL_INVALID_PRESERVED", permittedAttempt: "VERSIONED_PREFIX_ENVIRONMENT_RECOVERY_ONLY",
  ordinaryReplacementAttempt: "FORBIDDEN", repeatFailureDisposition: "STOP_CORE_DECISION_REQUIRED_N3_PREFIX_ENVIRONMENT_PROVENANCE",
  externalArtifact: prefixEnvironment.artifact, attemptsAllowed: 1,
});
const telemetryPolicy = addJson("04_PREFIX5_SPEND_TELEMETRY_POLICY.json", {
  schemaVersion: "direction-a.evo-fresh.prefix5-spend-telemetry-policy.v1", generatedAt: GENERATED_AT,
  budgetRole: "TELEMETRY_ONLY_NEVER_BLOCKS_EXECUTION", budgetNeverFailsClosed: true,
  freshCapCny: FRESH_INCREMENTAL_BUDGET_CAP_CNY, historicalFreshSpendCny: FRESH_HISTORICAL_FRESH_SPEND_CNY,
  protectedTotalCny: FRESH_PROTECTED_TOTAL_CNY, absoluteAccountingCeilingCny: FRESH_ABSOLUTE_ACCOUNTING_CEILING_CNY,
  peakProtectedReservationCny: FRESH_PEAK_PROTECTED_RESERVATION_CNY, peakPricing: true,
  ratesCnyPerMillionTokens: FRESH_PEAK_RATES_CNY_PER_MILLION_TOKENS, maxTurnsPerTrial: FRESH_MAX_TURNS_PER_TRIAL,
  maxAttemptsPerTask: FRESH_MAX_ATTEMPTS_PER_TASK, paidAuthorityHash: FRESH_PAID_AUTHORITY.contentHash,
  permittedStops: ["PROVIDER_REFUSAL_OR_INSUFFICIENT_BALANCE"], forbiddenStops: ["RESERVATION", "ROLLING_RESERVE", "INTERNAL_CAP_PROJECTION", "PROJECTED_OVERSPEND"],
  restrictedOperations: ["RECORD_ACTUAL_SPEND", "REPORT_COST", "RETAIN_HISTORY"],
});
const supersededArtifact = addJson("11_SUPERSEDED_FRESH_AUTHORIZATIONS.json", {
  schemaVersion: "direction-a.evo-fresh.superseded-authorizations.v1", generatedAt: GENERATED_AT,
  requests: priorRequests, approvalReuseForbidden: true,
});

// Byte-identical frozen carryover required by the phase runner and the feature-scoring snapshot.
const carriedFrozenNames = ["01_FINAL_T1_RECOVERY_INTEGRITY_CONSOLIDATION.json", "02_FINAL_RETRY_AWARE_PAIR_ORDER_ATTESTATIONS.json",
  "03_FINAL_RECOVERY_BUDGET_CLOSURE.json", "04_REPAIRED_T1_FIXED4_BANK.json", "05_REPAIRED_T1_PROVENANCE_MAP.json",
  "06_REPAIRED_POST_T1_8TASK_10GROUP_BANK.json", "07_POST_T1_REQUALIFICATION_RULE_FREEZE.json", "08_POST_T1_ABC_RESULTS.json",
  "09_POST_T1_PROCESS_ABLATION.json", "10_POST_T1_MODEL_CHECKPOINT.json", "11_FINAL_PROPOSED_MODEL_FREEZE.json",
  "12_FINAL_PRIMARY_BASELINE_FREEZE.json", "13_FINAL_STRONG_COMPARATOR_FREEZE.json", "16_FINAL_MODEL_SET_FREEZE.json",
  "FRESH_FEATURE_SCORING_BINDING.json"];
for (const name of carriedFrozenNames) setBytes(`frozen/post-t1/${name}`, readFileSync(resolve(postT1Root, name)));

// ---------------------------------------------------------------------------------------------
// F2: full transitive binding closure, mechanically regenerated
// ---------------------------------------------------------------------------------------------
const snapshot = readJson<FreshFeatureScoringBindingSnapshot>(resolve(postT1Root, "FRESH_FEATURE_SCORING_BINDING.json"));
const nestedBindings = collectPromotedFreshFeatureScoringBindings(workspaceRoot, snapshot);
const authorizationClosure = buildFreshLocalDependencyClosure({ workspaceRoot, roots: authorizationRoots, closureKind: "AUTHORIZATION_GENERATION" });
const paidClosure = buildFreshLocalDependencyClosure({ workspaceRoot, roots: paidRoots, closureKind: "PAID_EXECUTION" });
const unionMap = new Map<string, Json>();
for (const [kind, rows] of [["AUTHORIZATION_GENERATION", authorizationClosure.files], ["PAID_EXECUTION", paidClosure.files]] as const) {
  for (const row of rows) {
    const prior = unionMap.get(row.path); if (!prior) unionMap.set(row.path, { ...row, closureKinds: [kind] });
    else prior.closureKinds = [...new Set([...prior.closureKinds, kind])].sort();
  }
}
const unionFiles = [...unionMap.values()].sort((a, b) => a.path.localeCompare(b.path));

addText("00_READ_FIRST.md", `# Fresh FINAL recovery closure\n\nStatus: **REQUEST ONLY / NOT AUTHORIZED**. This closure fixes the three engineering blockers in one pass: every hash bound by the request is derived from a real artifact written here; the full transitive defense-in-depth binding closure is restored (${unionFiles.length} source/config files plus ${nestedBindings.length} promoted feature-scoring byte paths); and the phase runner is part of the bound paid path.\n\nBudget is telemetry only and can never fail-close a run; only a genuine provider refusal stops execution. The active sample stays the first ${FRESH_ACTIVE_PREFIX_N} tasks of the frozen N9 order, task 6 stays forbidden, and n3 keeps its historical try-1..3 technical invalids plus exactly one versioned bounded prefix-environment recovery.\n\nNo denominator re-qualification, no A/B/C, no fixed4/STABLE rerun, no provider/model call, no secret read, no paid Docker launch occurred.\n\nNEXT = READY_FOR_FRESH_RECOVERY_REAUTHORIZATION\n`);
addText("13_REPRODUCIBILITY_AND_BINDING_REPORT.md", `# Reproducibility and binding report\n\nStatus: **PASS_BYTE_IDENTICAL / zero-provider**.\n\nEvery artifact is emitted deterministically (\`node ... evo-fresh-final-recovery-closure.ts --check\` replays byte-identically). The request content hash is computed from the on-disk request body, and every other 64-hex field is the content hash of an artifact that was really written into this closure.\n\nBound surface: ${unionFiles.length} transitively reached source/config files, ${nestedBindings.length} promoted nested feature-scoring byte paths, ${carriedFrozenNames.length} byte-identical frozen post-T1 artifacts, and ${["00_READ_FIRST.md", "01_PEAK100_PREFIX5_BUDGET_TELEMETRY_DECISION.json", "02_ACTIVE_PREFIX5_EXACT_MANIFEST.json", "03_ACTIVE_PREFIX5_DENOMINATOR_RESTRICTION.json", "04_PREFIX5_SPEND_TELEMETRY_POLICY.json", "05_FAILFAST_NORMALIZATION_SPEC.json", "06_N3_PREFIX_ENVIRONMENT_MANIFEST.json", "07_ROLLING_WHOLE_TASK_RESERVE.json", "08_N3_RECOVERY_SEMANTICS.json", "09_PREPARED_MANIFEST_CONTRACT.json", "11_SUPERSEDED_FRESH_AUTHORIZATIONS.json", "13_REPRODUCIBILITY_AND_BINDING_REPORT.md", "WORKBUDDY_EVO_FRESH_FINAL_RECOVERY.md"].length} generated closure artifacts. No provider/model call, secret read, paid dispatch or Docker launch occurred.\n`);
addText("WORKBUDDY_EVO_FRESH_FINAL_RECOVERY.md", `# WorkBuddy — Fresh FINAL recovery authorization\n\nStatus: **REQUEST ONLY / NOT AUTHORIZED**. Bound by \`10_NEW_FRESH_AUTHORIZATION_REQUEST.json\`; not a grant.\n\n1. Accept only the exact researcher string \`APPROVE_EVO_FRESH_ENGINEERING_HOLDOUT <REQUEST_CONTENT_HASH>\`. Never reuse any superseded hash (${priorRequests.map((row) => `\`${row.contentHash}\``).join(", ")}).\n2. Verify all direct \`requiredBindings\` and run the zero-provider preflight; require \`REAUTHORIZATION_REQUIRED\`.\n3. After approval: materialize the grant, verify it, archive the superseded \`runtimeRoot/prepared\` bundle, prepare the current v3 bundle, then run the n3 bounded prefix-environment recovery and continue Phase1 to Phase3.\n4. Never re-run n1/n2, never rewrite the n3 try-1..3 provenance, never widen the sample, never add task 6, never buy data for significance.\n5. Budget is telemetry: record actual spend, report cost, keep history. Only a genuine provider refusal stops the run.\n`);
addJson("01_PEAK100_PREFIX5_BUDGET_TELEMETRY_DECISION.json", {
  schemaVersion: "direction-a.evo-fresh.peak100-prefix5-budget-telemetry-decision.v1", generatedAt: GENERATED_AT,
  status: "REQUEST_ONLY_NOT_AUTHORIZED", decisionId: FRESH_DECISION_ID,
  activePrefixN: FRESH_ACTIVE_PREFIX_N, task6PermanentNoStart: true, frozenTaskOrderUnchanged: true,
  budgetRole: "TELEMETRY_ONLY_NEVER_BLOCKS_EXECUTION", historicalFreshSpendCny: FRESH_HISTORICAL_FRESH_SPEND_CNY,
  freshCapCny: FRESH_INCREMENTAL_BUDGET_CAP_CNY, remainingFreshBudgetCny: FRESH_REMAINING_FRESH_BUDGET_CNY,
  expectedProviderCalls: FRESH_EXPECTED_CALLS, maximumProviderCalls: FRESH_MAX_CALLS,
  telemetryPolicyHash: telemetryPolicy.contentHash, rollingReserveHash: rollingReserve.contentHash,
  n3RecoveryHash: n3Recovery.contentHash, providerCalls: 0, modelCalls: 0, secretReads: 0,
});

const bindingRows = new Map<string, { path: string; sha256: string; source: string }>();
const put = (path: string, digest: string, source: string): void => {
  const prior = bindingRows.get(path); if (prior && prior.sha256 !== digest) throw new Error(`FRESH_BINDING_HASH_CONFLICT:${path}`);
  bindingRows.set(path, { path, sha256: digest, source });
};
for (const row of unionFiles) put(row.path, row.sha256, "TRANSITIVE_LOCAL_SOURCE_OR_CONFIG");
for (const name of carriedFrozenNames) put(workspacePath(`frozen/post-t1/${name}`), plannedSha(`frozen/post-t1/${name}`), "BYTE_IDENTICAL_FROZEN_POST_T1_ARTIFACT");
for (const row of nestedBindings) put(row.path, row.sha256, "PROMOTED_AUTHORITATIVE_FEATURE_SCORING_BINDING");
const generatedNames = ["00_READ_FIRST.md", "01_PEAK100_PREFIX5_BUDGET_TELEMETRY_DECISION.json", "02_ACTIVE_PREFIX5_EXACT_MANIFEST.json",
  "03_ACTIVE_PREFIX5_DENOMINATOR_RESTRICTION.json", "04_PREFIX5_SPEND_TELEMETRY_POLICY.json", "05_FAILFAST_NORMALIZATION_SPEC.json",
  "06_N3_PREFIX_ENVIRONMENT_MANIFEST.json", "07_ROLLING_WHOLE_TASK_RESERVE.json", "08_N3_RECOVERY_SEMANTICS.json",
  "09_PREPARED_MANIFEST_CONTRACT.json", "11_SUPERSEDED_FRESH_AUTHORIZATIONS.json", "13_REPRODUCIBILITY_AND_BINDING_REPORT.md",
  "WORKBUDDY_EVO_FRESH_FINAL_RECOVERY.md"];
for (const name of generatedNames) put(workspacePath(name), plannedSha(name), "GENERATED_CLOSURE_ARTIFACT");
const preManifestRows = [...bindingRows.values()].sort((a, b) => a.path.localeCompare(b.path));
const finalManifest = addJson("12_FINAL_TRANSITIVE_BINDING_MANIFEST.json", {
  schemaVersion: "direction-a.evo-fresh-final-required-binding-manifest.v3", generatedAt: GENERATED_AT,
  activePrefixN: FRESH_ACTIVE_PREFIX_N, sourceImportUnionFileCount: unionFiles.length,
  authoritativeNestedUniquePathCount: nestedBindings.length, generatedArtifactCount: generatedNames.length,
  frozenCarryoverCount: carriedFrozenNames.length, bindingsExcludingThisManifest: preManifestRows,
  thisManifestIsDirectlyBoundByAuthorizationRequest: true,
});
put(workspacePath("12_FINAL_TRANSITIVE_BINDING_MANIFEST.json"), plannedSha("12_FINAL_TRANSITIVE_BINDING_MANIFEST.json"), "FINAL_BINDING_MANIFEST");
const sortedBindings = [...bindingRows.values()].sort((a, b) => a.path.localeCompare(b.path));
if (sortedBindings.length <= 8) throw new Error(`FRESH_BINDING_SURFACE_NOT_RESTORED:${sortedBindings.length}`);
const requiredBindingPaths: Record<string, string> = {}; const requiredBindings: Record<string, string> = {};
for (const row of sortedBindings) { const key = `file:${row.path}`; requiredBindingPaths[key] = row.path; requiredBindings[key] = row.sha256; }

const requestBody = {
  schemaVersion: "direction-a.evo-fresh-n9-authorization-request.v1" as const, generatedAt: GENERATED_AT,
  decisionId: FRESH_DECISION_ID, status: "PENDING_RESEARCHER_REAUTHORIZATION" as const,
  requestedStage: "EVO_FRESH_ENGINEERING_HOLDOUT" as const, next: "READY_FOR_FRESH_RECOVERY_REAUTHORIZATION",
  authorized: false as const, materializedResearcherApproval: false as const, executeNow: false as const, allowPaidExecution: false as const,
  freshN: FRESH_N, activePrefixN: FRESH_ACTIVE_PREFIX_N, peakPricing: true as const, frozenN9PrefixLength: FRESH_FROZEN_N9_PREFIX_LENGTH,
  activePrefixTaskHash: FRESH_ACTIVE_PREFIX_TASK_HASH, forbiddenTailTaskIds: [...FRESH_FORBIDDEN_TAIL_TASK_IDS],
  freshPrefixHash: FRESH_PREFIX_HASH, exactManifestHash: exact.contentHash,
  preparedManifestSchema: "direction-a.evo-fresh-n9-prepared-manifest.v3" as const,
  preparedManifestContractHash: preparedManifestContract.contentHash,
  denominatorQualificationHash: restriction.contentHash, failFastNormalizationSpecHash: normalizationSpec.contentHash,
  runtimeRoot: FRESH_RUNTIME_ROOT, executionProfileHash: profile.contentHash, paidAuthorityHash: FRESH_PAID_AUTHORITY.contentHash,
  expectedProviderCalls: FRESH_EXPECTED_CALLS, maximumProviderCalls: FRESH_MAX_CALLS,
  priorReconciledSpendCny: FRESH_HISTORICAL_FRESH_SPEND_CNY,
  priorSpendTreatment: "HISTORICAL_FRESH_SPEND_CHARGED_TO_FRESH_CNY100" as const,
  budgetRole: "TELEMETRY_ONLY_NEVER_BLOCKS_EXECUTION" as const, budgetNeverFailsClosed: true as const,
  freshProtectedReservationCny: FRESH_PEAK_PROTECTED_RESERVATION_CNY, incrementalBudgetCapCny: FRESH_INCREMENTAL_BUDGET_CAP_CNY,
  absoluteAccountingCeilingCny: FRESH_ABSOLUTE_ACCOUNTING_CEILING_CNY, protectedTotalCny: FRESH_PROTECTED_TOTAL_CNY,
  globalHardCapCny: FRESH_ABSOLUTE_ACCOUNTING_CEILING_CNY, researcherBudgetExtensionMaximumCny: 0,
  approvalStringFormat: "APPROVE_EVO_FRESH_ENGINEERING_HOLDOUT <REQUEST_CONTENT_HASH>" as const,
  exactTaskIds: [...FRESH_TASK_IDS], exactCausalGroupIds: [...FRESH_GROUP_IDS],
  prefixEnvironmentManifestHash: prefixEnvironment.contentHash, preparedManifestContractFileHash: preparedManifestContract.contentHash,
  rollingWholeTaskReserveHash: rollingReserve.contentHash, n3RecoverySemanticsHash: n3Recovery.contentHash,
  spendTelemetryPolicyHash: telemetryPolicy.contentHash, supersededAuthorizationsHash: supersededArtifact.contentHash,
  forbidden: [...FRESH_REQUIRED_FORBIDDEN],
  requiredBindingPaths, requiredBindings, requiredBindingsCount: sortedBindings.length, requiredBindingsHash: hashCanonical(requiredBindings),
};
const newRequest = seal(requestBody) as unknown as FreshAuthorizationRequest & Json;
assertFreshAuthorizationRequest(newRequest);
if (priorRequests.some((row) => row.contentHash === newRequest.contentHash)) throw new Error("FRESH_FINAL_REQUEST_HASH_REUSE");
for (const row of nestedBindings) {
  const key = `file:${row.path}`;
  if (newRequest.requiredBindingPaths[key] !== row.path || newRequest.requiredBindings[key] !== row.sha256) {
    throw new Error(`FRESH_NESTED_BINDING_NOT_PROMOTED:${row.path}`);
  }
}
addJson("10_NEW_FRESH_AUTHORIZATION_REQUEST.json", newRequest as unknown as Json);

const inventoryRows = [...documents.entries()].sort(([a], [b]) => a.localeCompare(b))
  .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha(bytes) }));
documents.set("SHA256_INVENTORY.json", stable(seal({ schemaVersion: "direction-a.evo-fresh-final-recovery-inventory.v1", generatedAt: GENERATED_AT, files: inventoryRows })));

for (const [name, bytes] of [...documents.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const target = resolve(outputRoot, name);
  if (existsSync(target)) {
    if (!readFileSync(target).equals(bytes)) {
      if (!refresh) throw new Error(`IMMUTABLE_OUTPUT_DRIFT:${name}`);
      writeFileSync(target, bytes);
    }
  } else {
    if (checkOnly) throw new Error(`DETERMINISTIC_REPLAY_MISSING:${name}`);
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes, { flag: "wx" });
  }
}

console.log("FRESH_FINAL_RECOVERY_CLOSURE_COMPLETE");
console.log(`activePrefixN=${FRESH_ACTIVE_PREFIX_N}`);
console.log(`requiredBindings=${sortedBindings.length}`);
console.log(`transitiveFiles=${unionFiles.length}`);
console.log(`promotedNestedBindings=${nestedBindings.length}`);
console.log(`generatedArtifacts=${generatedNames.length}`);
console.log(`frozenCarryover=${carriedFrozenNames.length}`);
console.log(`exactManifestHash=${exact.contentHash}`);
console.log(`denominatorRestrictionHash=${restriction.contentHash}`);
console.log(`normalizationSpecHash=${normalizationSpec.contentHash}`);
console.log(`preparedManifestContractHash=${preparedManifestContract.contentHash}`);
console.log(`prefixEnvironmentManifestHash=${prefixEnvironment.contentHash}`);
console.log(`denominators=${denominators.join(",")}`);
console.log(`contentHash=${newRequest.contentHash}`);
console.log(`requestFileSha256=${plannedSha("10_NEW_FRESH_AUTHORIZATION_REQUEST.json")}`);
console.log("providerCalls=0 modelCalls=0 secretReads=0 paidDockerLaunches=0");
console.log("NEXT=READY_FOR_FRESH_RECOVERY_REAUTHORIZATION");
