/** Zero-provider, zero-secret pre-authorization verification for the transitive Fresh request. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertRealExecutionProfile, type RealExecutionProfile } from "../../../src/evaluation/direction-a/formal/acquisition/execution-profile.js";
import { hashCanonical } from "../../../src/evaluation/direction-a/formal/core/canonical.js";
import { assertFreshAuthorizationRequest, type FreshAuthorizationRequest } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-execution-gate.js";
import { assertFreshExactManifest, type FreshExactManifest } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-manifest.js";
import { collectPromotedFreshFeatureScoringBindings, verifyFreshRequiredBindings } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-binding-verification.js";
import type { FreshFeatureScoringBindingSnapshot } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-feature-scoring.js";
import { hashDirectoryTree } from "../../../src/evaluation/direction-a/formal/executors/evo-harbor-executor.js";
import { assertFreshDenominatorQualification, type FreshDenominatorQualification } from "../../../src/evaluation/direction-a/formal/evo-fresh/failfast-case-accounting.js";

const repoRoot = resolve(process.cwd()); const workspaceRoot = resolve(repoRoot, "..");
const arg = (name: string): string | undefined => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const closureRoot = resolve(arg("--closure-root") ?? resolve(workspaceRoot, "Direction_A_Evo_Fresh_FinalRecovery_Closure_v1"));
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const fileSha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

const request = readJson<FreshAuthorizationRequest & Record<string, unknown>>(resolve(closureRoot, "10_NEW_FRESH_AUTHORIZATION_REQUEST.json"));
assertFreshAuthorizationRequest(request);
// Supersession is read from the bound artifact, so this preflight works for any authorized request.
const superseded = readJson<{ requests: Array<{ contentHash: string; path: string; fileSha256: string; reusable: boolean }>; contentHash: string }>(
  resolve(closureRoot, "11_SUPERSEDED_FRESH_AUTHORIZATIONS.json"));
const { contentHash: supersededHash, ...supersededBody } = superseded;
if (hashCanonical(supersededBody) !== supersededHash || request.supersededAuthorizationsHash !== supersededHash
  || superseded.requests.length < 1
  || superseded.requests.some((row) => row.contentHash === request.contentHash || row.reusable
    || fileSha(resolve(workspaceRoot, row.path)) !== row.fileSha256)) {
  throw new Error("FRESH_SUPERSESSION_BINDING_MISMATCH");
}
verifyFreshRequiredBindings(workspaceRoot, request);
const featureBindings = readJson<FreshFeatureScoringBindingSnapshot>(resolve(closureRoot, "frozen/post-t1/FRESH_FEATURE_SCORING_BINDING.json"));
for (const row of collectPromotedFreshFeatureScoringBindings(workspaceRoot, featureBindings)) {
  const key = `file:${row.path}`;
  if (request.requiredBindingPaths[key] !== row.path || request.requiredBindings[key] !== row.sha256) {
    throw new Error(`FRESH_PREFLIGHT_NESTED_BINDING_NOT_DIRECT:${row.path}`);
  }
}
const exact = readJson<FreshExactManifest>(resolve(closureRoot, "02_ACTIVE_PREFIX5_EXACT_MANIFEST.json")); assertFreshExactManifest(exact);
const qualification = readJson<FreshDenominatorQualification>(resolve(closureRoot, "03_ACTIVE_PREFIX5_DENOMINATOR_RESTRICTION.json"));
assertFreshDenominatorQualification(qualification, exact);
if (!["direction-a.evo-fresh-n9-prepared-manifest.v2", "direction-a.evo-fresh-n9-prepared-manifest.v3"].includes(request.preparedManifestSchema)
  || request.denominatorQualificationHash !== qualification.contentHash) throw new Error("FRESH_REQUALIFIED_PROTOCOL_BINDING_MISMATCH");
for (const source of exact.sourceInventory) {
  const sourceRoot = resolve(repoRoot, source.sourceTaskRelativePath);
  for (const required of [sourceRoot, resolve(repoRoot, source.sourceMemoryInstructionRelativePath),
    resolve(repoRoot, source.targetInstructionRelativePath), resolve(repoRoot, source.targetTestsRelativePath)]) {
    if (!existsSync(required)) throw new Error(`FRESH_SOURCE_INVENTORY_PATH_ABSENT:${source.taskId}`);
  }
  if (await hashDirectoryTree(sourceRoot) !== source.sourceTaskDirectoryHash) {
    throw new Error(`FRESH_SOURCE_INVENTORY_HASH_DRIFT:${source.taskId}`);
  }
}
const profile = readJson<RealExecutionProfile>(resolve(repoRoot, ".research/direction-a/current-formal/pilot/manifests/real-execution-profile-v3.json"));
assertRealExecutionProfile(profile);
if (request.exactManifestHash !== exact.contentHash || request.executionProfileHash !== profile.contentHash) {
  throw new Error("FRESH_PREFLIGHT_RUNTIME_BINDING_MISMATCH");
}
const grantPath = resolve(closureRoot, "authorization/FRESH_AUTHORIZATION_N9.json");
if (existsSync(grantPath)) throw new Error("FRESH_REAL_RESEARCHER_GRANT_ALREADY_MATERIALIZED");
const { contentHash, ...body } = request;
if (hashCanonical(body) !== contentHash) throw new Error("FRESH_PREFLIGHT_REQUEST_REPLAY_FAIL");
console.log("FRESH_ZERO_PROVIDER_TRANSITIVE_BINDING_PREFLIGHT_PASS");
console.log(`requiredBindings=${request.requiredBindingsCount}`);
console.log("providerCalls=0 modelCalls=0 secretReads=0 paidDockerLaunches=0 freshCalls=0 t2Calls=0 q6Calls=0");
console.log("REAUTHORIZATION_REQUIRED");
