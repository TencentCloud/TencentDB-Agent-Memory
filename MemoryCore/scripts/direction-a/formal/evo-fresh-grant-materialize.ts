/** Zero provider/model calls, zero secret reads, zero Docker. Researcher approval is an explicit CLI value. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { assertRealExecutionProfile, type RealExecutionProfile } from "../../../src/evaluation/direction-a/formal/acquisition/execution-profile.js";
import { assertFreshAuthorizationRequest, assertFreshImmutableGrantWrite, createFreshImmutableGrant,
  type FreshAuthorizationRequest, type FreshImmutableGrant } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-execution-gate.js";
import { assertFreshExactManifest, type FreshExactManifest } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-manifest.js";
import { verifyFreshRequiredBindings } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-binding-verification.js";

const repoRoot = resolve(process.cwd()); const workspaceRoot = resolve(repoRoot, "..");
const arg = (name: string): string | undefined => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const closureRoot = resolve(arg("--closure-root") ?? resolve(workspaceRoot, "Direction_A_Evo_Fresh_FinalRecovery_Closure_v1"));
const requestPath = resolve(closureRoot, "10_NEW_FRESH_AUTHORIZATION_REQUEST.json");
const exactPath = resolve(closureRoot, "02_ACTIVE_PREFIX5_EXACT_MANIFEST.json");
const profilePath = resolve(repoRoot, ".research/direction-a/current-formal/pilot/manifests/real-execution-profile-v3.json");
const grantPath = resolve(closureRoot, "authorization/FRESH_AUTHORIZATION_N9.json");
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const fileSha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

const request = readJson<FreshAuthorizationRequest>(resolve(arg("--request") ?? requestPath)); assertFreshAuthorizationRequest(request);
verifyFreshRequiredBindings(workspaceRoot, request);
const exact = readJson<FreshExactManifest>(exactPath); assertFreshExactManifest(exact);
const profile = readJson<RealExecutionProfile>(profilePath); assertRealExecutionProfile(profile);
const approvalText = arg("--approval");
if (!approvalText) throw new Error(`FRESH_RESEARCHER_APPROVAL_REQUIRED:APPROVE_EVO_FRESH_ENGINEERING_HOLDOUT ${request.contentHash}`);
const grant = createFreshImmutableGrant({ request, exact, profile, approvalText });
const target = resolve(arg("--grant-output") ?? grantPath);
if (existsSync(target)) {
  const existing = readJson<FreshImmutableGrant>(target);
  assertFreshImmutableGrantWrite(existing, grant);
  console.log("FRESH_GRANT_ALREADY_MATERIALIZED_IDEMPOTENT"); process.exit(0);
}
mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, `${JSON.stringify(grant, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log("FRESH_GRANT_MATERIALIZED"); console.log(`grantPath=${target}`); console.log(`grantContentHash=${grant.contentHash}`);
console.log("providerCalls=0 modelCalls=0 secretReads=0 dockerLaunches=0");
