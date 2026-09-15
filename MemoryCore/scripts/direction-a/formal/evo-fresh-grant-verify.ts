/** Independent immutable grant re-read. Zero provider/model calls, zero secret reads, zero Docker. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertRealExecutionProfile, type RealExecutionProfile } from "../../../src/evaluation/direction-a/formal/acquisition/execution-profile.js";
import { hashCanonical } from "../../../src/evaluation/direction-a/formal/core/canonical.js";
import { assertFreshAuthorizationRequest, authorizeFreshExecutionPermit, createFreshImmutableGrant,
  type FreshAuthorizationRequest, type FreshImmutableGrant } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-execution-gate.js";
import { assertFreshExactManifest, assertFreshPreparedExecutionManifest, assertFreshPreparedRuntimeBytes,
  type FreshExactManifest, type FreshPreparedExecutionManifest } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-manifest.js";
import { verifyFreshRequiredBindings } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-binding-verification.js";

const repoRoot = resolve(process.cwd()); const workspaceRoot = resolve(repoRoot, "..");
const arg = (name: string): string | undefined => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const closureRoot = resolve(arg("--closure-root") ?? resolve(workspaceRoot, "Direction_A_Evo_Fresh_FinalRecovery_Closure_v1"));
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const fileSha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const request = readJson<FreshAuthorizationRequest>(resolve(arg("--request") ?? resolve(closureRoot, "10_NEW_FRESH_AUTHORIZATION_REQUEST.json")));
assertFreshAuthorizationRequest(request);
verifyFreshRequiredBindings(workspaceRoot, request);
const exact = readJson<FreshExactManifest>(resolve(closureRoot, "02_ACTIVE_PREFIX5_EXACT_MANIFEST.json")); assertFreshExactManifest(exact);
const profile = readJson<RealExecutionProfile>(resolve(repoRoot, ".research/direction-a/current-formal/pilot/manifests/real-execution-profile-v3.json")); assertRealExecutionProfile(profile);
const grantPath = resolve(arg("--grant") ?? resolve(closureRoot, "authorization/FRESH_AUTHORIZATION_N9.json"));
if (!existsSync(grantPath)) throw new Error("FRESH_IMMUTABLE_GRANT_ABSENT");
const grant = readJson<FreshImmutableGrant>(grantPath); const { contentHash, ...body } = grant;
if (hashCanonical(body) !== contentHash) throw new Error("FRESH_GRANT_CONTENT_HASH_MISMATCH");
const replay = createFreshImmutableGrant({ request, exact, profile, approvalText: grant.approvalText });
if (replay.contentHash !== grant.contentHash) throw new Error("FRESH_GRANT_INDEPENDENT_REPLAY_MISMATCH");
console.log("FRESH_GRANT_VERIFIED"); console.log(`grantContentHash=${grant.contentHash}`); console.log(`grantFileSha256=${fileSha(grantPath)}`);
const preparedPath = resolve(arg("--prepared") ?? resolve(request.runtimeRoot, "prepared/FRESH_N9_PREPARED_EXECUTION_MANIFEST.json"));
if (existsSync(preparedPath)) {
  const prepared = readJson<FreshPreparedExecutionManifest>(preparedPath); assertFreshPreparedExecutionManifest(prepared, exact);
  await assertFreshPreparedRuntimeBytes(repoRoot, prepared, exact);
  const permit = authorizeFreshExecutionPermit({ grant, request, exact, prepared, profile });
  console.log("FRESH_TYPED_PERMIT_VERIFIED"); console.log(`preparedManifestHash=${permit.preparedManifestHash}`);
} else console.log("FRESH_TYPED_PERMIT_PENDING_PREPARED_BUNDLE");
console.log("providerCalls=0 modelCalls=0 secretReads=0 dockerLaunches=0");
