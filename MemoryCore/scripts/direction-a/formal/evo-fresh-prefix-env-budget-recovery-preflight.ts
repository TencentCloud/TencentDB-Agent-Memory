/** Zero-provider gate for the versioned n3 prefix-environment recovery request. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifyFreshRequiredBindings } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-binding-verification.js";
import { assertFreshAuthorizationRequest, type FreshAuthorizationRequest } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-execution-gate.js";
import { assertN3PrefixEnvironmentManifest, type N3PrefixEnvironmentManifest } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-prefix-environment-recovery.js";

const repoRoot = resolve(process.cwd()); const workspaceRoot = resolve(repoRoot, "..");
const at = process.argv.indexOf("--closure-root"); const closureRoot = resolve(at < 0 ? resolve(workspaceRoot, "Direction_A_Evo_Fresh_FinalRecovery_Closure_v1") : process.argv[at + 1]!);
const json = <T>(name: string): T => JSON.parse(readFileSync(resolve(closureRoot, name), "utf8")) as T;
const request = json<FreshAuthorizationRequest>("10_NEW_FRESH_AUTHORIZATION_REQUEST.json");
assertFreshAuthorizationRequest(request); assertN3PrefixEnvironmentManifest(repoRoot, json<N3PrefixEnvironmentManifest>("06_N3_PREFIX_ENVIRONMENT_MANIFEST.json"));
const bindingCount = verifyFreshRequiredBindings(workspaceRoot, request);
if (existsSync(resolve(closureRoot, "authorization"))) throw new Error("FRESH_RECOVERY_PREFLIGHT_GRANT_MATERIALIZATION_FORBIDDEN");
console.log(JSON.stringify({ status: "REAUTHORIZATION_REQUIRED", providerCalls: 0, paidCalls: 0, grantMaterialized: false, bindingCount }));
