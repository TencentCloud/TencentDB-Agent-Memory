/**
 * Zero-provider, zero-secret authorization gate for the FINAL Fresh recovery closure.
 *
 * Proves the three fixes before anything is materialized:
 *   F1 — every 64-hex field of the request is the content hash of an artifact that really exists,
 *        and every artifact re-derives to the hash the request binds (no placeholder literals).
 *   F2 — the full defense-in-depth binding surface verifies (never an 8-path minimal set).
 *   F3 — the phase runner is bound; the n3 bounded recovery is declared and structurally available.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hashCanonical } from "../../../src/evaluation/direction-a/formal/core/canonical.js";
import { assertRealExecutionProfile, type RealExecutionProfile } from "../../../src/evaluation/direction-a/formal/acquisition/execution-profile.js";
import { assertFreshAuthorizationRequest, FRESH_REQUIRED_FORBIDDEN,
  type FreshAuthorizationRequest } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-execution-gate.js";
import { assertFreshExactManifest, type FreshExactManifest } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-manifest.js";
import { assertFreshDenominatorQualification, normalizeFailFastCaseAccountingVerifier,
  type FreshDenominatorQualification } from "../../../src/evaluation/direction-a/formal/evo-fresh/failfast-case-accounting.js";
import { assertN3PrefixEnvironmentManifest, N3_PREFIX_ENVIRONMENT_ARTIFACT_PATH, N3_PREFIX_ENVIRONMENT_ATTEMPT_ID,
  N3_PREFIX_ENVIRONMENT_RECOVERY_ID, type N3PrefixEnvironmentManifest } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-prefix-environment-recovery.js";
import { FRESH_PAID_AUTHORITY } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-paid-authority.js";
import { collectPromotedFreshFeatureScoringBindings, verifyFreshRequiredBindings } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-binding-verification.js";
import type { FreshFeatureScoringBindingSnapshot } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-feature-scoring.js";
import { hashDirectoryTree } from "../../../src/evaluation/direction-a/formal/executors/evo-harbor-executor.js";

type Json = Record<string, any>;
const repoRoot = resolve(process.cwd()); const workspaceRoot = resolve(repoRoot, "..");
const arg = (name: string): string | undefined => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const closureRoot = resolve(arg("--closure-root") ?? resolve(workspaceRoot, "Direction_A_Evo_Fresh_FinalRecovery_Closure_v1"));
const json = <T>(name: string): T => JSON.parse(readFileSync(resolve(closureRoot, name), "utf8")) as T;
const fileSha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

if (existsSync(resolve(closureRoot, "authorization"))) throw new Error("FRESH_FINAL_PREFLIGHT_GRANT_MATERIALIZATION_FORBIDDEN");

const request = json<FreshAuthorizationRequest & Json>("10_NEW_FRESH_AUTHORIZATION_REQUEST.json");
assertFreshAuthorizationRequest(request);

// F1: artifact existence + hash agreement.
const artifactChecks: Array<{ field: string; file: string; bound?: string }> = [
  { field: "exactManifestHash", file: "02_ACTIVE_PREFIX5_EXACT_MANIFEST.json", bound: request.exactManifestHash },
  { field: "denominatorQualificationHash", file: "03_ACTIVE_PREFIX5_DENOMINATOR_RESTRICTION.json", bound: request.denominatorQualificationHash },
  { field: "spendTelemetryPolicyHash", file: "04_PREFIX5_SPEND_TELEMETRY_POLICY.json", bound: request.spendTelemetryPolicyHash },
  { field: "failFastNormalizationSpecHash", file: "05_FAILFAST_NORMALIZATION_SPEC.json", bound: request.failFastNormalizationSpecHash },
  { field: "prefixEnvironmentManifestHash", file: "06_N3_PREFIX_ENVIRONMENT_MANIFEST.json", bound: request.prefixEnvironmentManifestHash },
  { field: "rollingWholeTaskReserveHash", file: "07_ROLLING_WHOLE_TASK_RESERVE.json", bound: request.rollingWholeTaskReserveHash },
  { field: "n3RecoverySemanticsHash", file: "08_N3_RECOVERY_SEMANTICS.json", bound: request.n3RecoverySemanticsHash },
  { field: "preparedManifestContractHash", file: "09_PREPARED_MANIFEST_CONTRACT.json", bound: request.preparedManifestContractHash },
  { field: "supersededAuthorizationsHash", file: "11_SUPERSEDED_FRESH_AUTHORIZATIONS.json", bound: request.supersededAuthorizationsHash },
  { field: "finalBindingManifestHash", file: "12_FINAL_TRANSITIVE_BINDING_MANIFEST.json", bound: undefined },
];
const artifactEvidence: Array<{ field: string; file: string; bound: string | null; actual: string | null; exists: boolean; match: boolean }> = [];
for (const check of artifactChecks) {
  const absolute = resolve(closureRoot, check.file);
  if (!existsSync(absolute)) throw new Error(`FRESH_FINAL_PREFLIGHT_BOUND_ARTIFACT_MISSING:${check.file}`);
  const document = JSON.parse(readFileSync(absolute, "utf8")) as Json;
  const { contentHash, ...body } = document;
  if (typeof contentHash !== "string" || hashCanonical(body) !== contentHash) throw new Error(`FRESH_FINAL_PREFLIGHT_ARTIFACT_HASH_DRIFT:${check.file}`);
  const match = check.bound === undefined || check.bound === contentHash;
  if (!match) throw new Error(`FRESH_FINAL_PREFLIGHT_BOUND_HASH_MISMATCH:${check.field}:${check.file}`);
  artifactEvidence.push({ field: check.field, file: check.file, bound: check.bound ?? null, actual: contentHash, exists: true, match });
}
for (const path of Object.values(request.requiredBindingPaths)) {
  if (!existsSync(resolve(workspaceRoot, path))) throw new Error(`FRESH_FINAL_PREFLIGHT_REQUIRED_BINDING_ABSENT:${path}`);
}

// Semantic re-derivation of the artifacts that carry the measurement and prefix-environment authority.
const exact = json<FreshExactManifest>("02_ACTIVE_PREFIX5_EXACT_MANIFEST.json"); assertFreshExactManifest(exact);
if (request.exactManifestHash !== exact.contentHash) throw new Error("FRESH_FINAL_PREFLIGHT_EXACT_MANIFEST_MISMATCH");
const restriction = json<FreshDenominatorQualification>("03_ACTIVE_PREFIX5_DENOMINATOR_RESTRICTION.json");
assertFreshDenominatorQualification(restriction, exact);
if (restriction.entries.map((row) => row.qualifiedTotalCases).join(",") !== "62,160,111,32,323") {
  throw new Error("FRESH_FINAL_PREFLIGHT_DENOMINATOR_DRIFT");
}
const prefixEnvironment = json<N3PrefixEnvironmentManifest>("06_N3_PREFIX_ENVIRONMENT_MANIFEST.json");
assertN3PrefixEnvironmentManifest(repoRoot, prefixEnvironment);
if (prefixEnvironment.artifact.targetPath !== N3_PREFIX_ENVIRONMENT_ARTIFACT_PATH || !prefixEnvironment.artifact.requiredExecutable
  || prefixEnvironment.recoveryAttemptId !== N3_PREFIX_ENVIRONMENT_ATTEMPT_ID
  || prefixEnvironment.recoveryId !== N3_PREFIX_ENVIRONMENT_RECOVERY_ID) throw new Error("FRESH_FINAL_PREFLIGHT_PREFIX_ENVIRONMENT_INVALID");

const recovery = json<Json>("08_N3_RECOVERY_SEMANTICS.json");
if (recovery.recoveryId !== "N3_NORMAL_PREFIX_ENVIRONMENT_RECOVERY" || recovery.attemptsAllowed !== 1
  || recovery.ordinaryReplacementAttempt !== "FORBIDDEN" || recovery.oldAttemptDisposition !== "INFRASTRUCTURE_TECHNICAL_INVALID_PRESERVED"
  || hashCanonical(recovery.oldAttempts) !== hashCanonical(["try-1", "try-2", "try-3"])) throw new Error("FRESH_FINAL_PREFLIGHT_N3_RECOVERY_SEMANTICS_INVALID");
const telemetry = json<Json>("04_PREFIX5_SPEND_TELEMETRY_POLICY.json");
if (telemetry.budgetRole !== "TELEMETRY_ONLY_NEVER_BLOCKS_EXECUTION" || telemetry.budgetNeverFailsClosed !== true
  || hashCanonical(telemetry.forbiddenStops) !== hashCanonical(["RESERVATION", "ROLLING_RESERVE", "INTERNAL_CAP_PROJECTION", "PROJECTED_OVERSPEND"])) {
  throw new Error("FRESH_FINAL_PREFLIGHT_SPEND_TELEMETRY_POLICY_INVALID");
}
const n4 = restriction.entries[3];
const n4Normalized = normalizeFailFastCaseAccountingVerifier(readFileSync(resolve(repoRoot,
  `.research/direction-a/v6.3/dependencies/evocodebench_wotraj/${n4.taskId}/steps/round-${n4.targetRound}/tests/test.sh`), "utf8"));
const spec = json<Json>("05_FAILFAST_NORMALIZATION_SPEC.json");
if (spec.normalizedVerifierSha256 !== n4Normalized.normalizedVerifierSha256 || spec.registeredCaseCount !== n4Normalized.totalCases
  || spec.activePrefix5QualificationHash !== restriction.contentHash || spec.metric !== "SUCCESS_COUNT_DIVIDED_BY_TOTAL_CASES") {
  throw new Error("FRESH_FINAL_PREFLIGHT_NORMALIZATION_SPEC_DRIFT");
}

// F2: full binding surface, plus the promoted nested feature-scoring bytes.
const declaredPaths = Object.values(request.requiredBindingPaths);
if (declaredPaths.length <= 8) throw new Error(`FRESH_FINAL_PREFLIGHT_BINDING_SURFACE_NOT_RESTORED:${declaredPaths.length}`);
for (const required of ["MemoryCore/src/evaluation/direction-a/formal/evo-fresh/fresh-feature-scoring.ts",
  "MemoryCore/src/evaluation/direction-a/formal/modeling/evo-continuous-adaptation.ts",
  "MemoryCore/src/evaluation/direction-a/formal/evo-fresh/fresh-manifest.ts",
  "MemoryCore/src/evaluation/direction-a/formal/evo-fresh/fresh-execution-gate.ts",
  "MemoryCore/src/evaluation/direction-a/formal/evo-fresh/fresh-prey-runtime.ts",
  "MemoryCore/src/evaluation/direction-a/formal/evo-fresh/failfast-case-accounting.ts",
  "MemoryCore/src/evaluation/direction-a/formal/evo-fresh/fresh-paid-authority.ts",
  "MemoryCore/src/evaluation/direction-a/formal/evo-fresh/fresh-prefix-environment-recovery.ts",
  "MemoryCore/scripts/direction-a/formal/evo-fresh-paid-run.ts",
  "MemoryCore/scripts/direction-a/formal/evo-fresh-prepare.ts",
  "MemoryCore/.research/direction-a/current-formal/pilot/manifests/real-execution-profile-v3.json",
  "Direction_A_PostCAL_Model_Value_v2_1/11_PROPOSED_V2_FINAL_MODEL.json",
  "Direction_A_PostCAL_Model_Value_v2_1/12_BASELINE_V2_FINAL_MODEL.json"]) {
  if (!declaredPaths.includes(required)) throw new Error(`FRESH_FINAL_PREFLIGHT_REQUIRED_PATH_NOT_BOUND:${required}`);
}
const bindingCount = verifyFreshRequiredBindings(workspaceRoot, request);
const snapshot = json<FreshFeatureScoringBindingSnapshot>("frozen/post-t1/FRESH_FEATURE_SCORING_BINDING.json");
for (const row of collectPromotedFreshFeatureScoringBindings(workspaceRoot, snapshot)) {
  const key = `file:${row.path}`;
  if (request.requiredBindingPaths[key] !== row.path || request.requiredBindings[key] !== row.sha256) {
    throw new Error(`FRESH_FINAL_PREFLIGHT_NESTED_BINDING_NOT_DIRECT:${row.path}`);
  }
}

const profile = json<RealExecutionProfile>(resolve(repoRoot, ".research/direction-a/current-formal/pilot/manifests/real-execution-profile-v3.json"));
assertRealExecutionProfile(profile);
if (request.executionProfileHash !== profile.contentHash || request.paidAuthorityHash !== FRESH_PAID_AUTHORITY.contentHash) {
  throw new Error("FRESH_FINAL_PREFLIGHT_RUNTIME_BINDING_MISMATCH");
}
if (FRESH_REQUIRED_FORBIDDEN.some((entry) => !request.forbidden.includes(entry))) throw new Error("FRESH_FINAL_PREFLIGHT_FORBIDDEN_INCOMPLETE");
for (const source of exact.sourceInventory) {
  const sourceRoot = resolve(repoRoot, source.sourceTaskRelativePath);
  for (const required of [sourceRoot, resolve(repoRoot, source.sourceMemoryInstructionRelativePath),
    resolve(repoRoot, source.targetInstructionRelativePath), resolve(repoRoot, source.targetTestsRelativePath)]) {
    if (!existsSync(required)) throw new Error(`FRESH_FINAL_PREFLIGHT_SOURCE_INVENTORY_ABSENT:${source.taskId}`);
  }
  if (await hashDirectoryTree(sourceRoot) !== source.sourceTaskDirectoryHash) throw new Error(`FRESH_FINAL_PREFLIGHT_SOURCE_INVENTORY_HASH_DRIFT:${source.taskId}`);
}

console.log(JSON.stringify({ status: "REAUTHORIZATION_REQUIRED", providerCalls: 0, paidCalls: 0, secretReads: 0,
  dockerLaunches: 0, grantMaterialized: false, bindingCount, boundArtifacts: artifactEvidence.length,
  nestedPromotedBindings: collectPromotedFreshFeatureScoringBindings(workspaceRoot, snapshot).length,
  contentHash: request.contentHash, fileSha256: fileSha(resolve(closureRoot, "10_NEW_FRESH_AUTHORIZATION_REQUEST.json")),
  next: "READY_FOR_FRESH_RECOVERY_REAUTHORIZATION" }, null, 0));
console.log("REAUTHORIZATION_REQUIRED");
