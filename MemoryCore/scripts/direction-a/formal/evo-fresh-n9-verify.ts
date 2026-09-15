import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertFreshAuthorizationRequest, assertFreshExactManifest, assertFreshFeatureScoringByteBindings,
  hashCanonical, hashDirectoryTree, type FreshAuthorizationRequest, type FreshExactManifest, type FreshFeatureScoringBindingSnapshot,
} from "../../../src/evaluation/direction-a/formal/index.js";

const repoRoot = resolve(process.cwd()); const workspaceRoot = resolve(repoRoot, "..");
const arg = (name: string): string | undefined => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const root = resolve(arg("--root") ?? resolve(workspaceRoot, "Direction_A_Evo_Fresh_N9_Grant_Runtime_Adapter_Closure_v1"));
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const exact = readJson<FreshExactManifest>(resolve(root, "03_FRESH_EXACT_MANIFEST_FREEZE.json")); assertFreshExactManifest(exact);
const prefix = readJson<any>(resolve(workspaceRoot, "Direction_A_Evo_Engineering_First_Budget100_v1/07_FRESH13_PREFIX_FREEZE.json"));
const { contentHash: prefixContentHash, ...prefixBody } = prefix;
if (hashCanonical(prefixBody) !== prefixContentHash || prefix.prefixHash !== exact.prefixHash || prefix.futureSelection !== "FIRST_N_TASKS_ONLY") {
  throw new Error("FRESH_FROZEN_PREFIX_SOURCE_INVALID");
}
const prefixTasks = prefix.orderedTasks.slice(0, 9).map((row: any) => ({ prefixIndex: row.prefixIndex, taskId: row.taskId,
  statisticalClusterId: row.statisticalClusterId, officialDomainId: row.officialDomainId,
  canonicalCausalGroupId: row.canonicalCausalGroupId, targetRound: row.targetRound, taskCandidateHash: row.taskCandidateHash,
  sourceTaskDirectoryHash: row.sourceTaskDirectoryHash, groupCandidateHash: row.groupCandidateHash, sourceEvidenceHash: row.sourceEvidenceHash }));
if (hashCanonical(prefixTasks) !== hashCanonical(exact.tasks)) throw new Error("FRESH_EXACT_N9_NOT_FIRST_FROZEN_PREFIX");
for (const source of exact.sourceInventory) {
  const directory = resolve(repoRoot, source.sourceTaskRelativePath);
  for (const required of [directory, resolve(repoRoot, source.sourceMemoryInstructionRelativePath),
    resolve(repoRoot, source.targetInstructionRelativePath), resolve(repoRoot, source.targetTestsRelativePath)]) {
    if (!existsSync(required)) throw new Error(`FRESH_SOURCE_INVENTORY_PATH_ABSENT:${source.taskId}:${required}`);
  }
  if (await hashDirectoryTree(directory) !== source.sourceTaskDirectoryHash) throw new Error(`FRESH_SOURCE_INVENTORY_HASH_DRIFT:${source.taskId}`);
}
const request = readJson<FreshAuthorizationRequest>(resolve(root, "13_FRESH_AUTHORIZATION_REQUEST.json")); assertFreshAuthorizationRequest(request);
for (const [key, relativePath] of Object.entries(request.requiredBindingPaths)) {
  const absolute = resolve(workspaceRoot, relativePath);
  if (!existsSync(absolute) || sha(absolute) !== request.requiredBindings[key]) throw new Error(`FRESH_CLOSURE_REQUIRED_BINDING_DRIFT:${key}`);
}
if (request.exactManifestHash !== exact.contentHash) throw new Error("FRESH_CLOSURE_REQUEST_EXACT_MANIFEST_MISMATCH");
assertFreshFeatureScoringByteBindings(workspaceRoot,
  readJson<FreshFeatureScoringBindingSnapshot>(resolve(root, "09_FRESH_FEATURE_SCORING_BINDING.json")));
for (const name of ["02_N9_SAMPLE_AND_BUDGET_AMENDMENT.json", "04_FRESH_RUNTIME_BINDING.json", "05_FRESH_GRANT_GATE_FREEZE.json",
  "06_FRESH_PREPARED_MANIFEST_CONTRACT.json", "07_FRESH_PAID_AUTHORITY_FREEZE.json", "08_FRESH_BUDGET_ACCOUNTING_FREEZE.json",
  "09_FRESH_FEATURE_SCORING_BINDING.json", "10_FRESH_PHASE_BOUNDARY_FREEZE.json", "11_FRESH_RESUME_RETRY_FREEZE.json",
  "12_FRESH_EXECUTOR_BINDING.json", "SHA256_INVENTORY.json"]) {
  const value = readJson<Record<string, unknown> & { contentHash: string }>(resolve(root, name)); const { contentHash, ...body } = value;
  if (hashCanonical(body) !== contentHash) throw new Error(`FRESH_CLOSURE_CONTENT_HASH_MISMATCH:${name}`);
}
const inventory = readJson<{ files: Array<{ path: string; bytes: number; sha256: string }> }>(resolve(root, "SHA256_INVENTORY.json"));
for (const row of inventory.files) {
  const path = resolve(root, row.path);
  if (!existsSync(path) || readFileSync(path).byteLength !== row.bytes || sha(path) !== row.sha256) throw new Error(`FRESH_CLOSURE_INVENTORY_DRIFT:${row.path}`);
}
const forbiddenRealGrant = resolve(root, "authorization/FRESH_AUTHORIZATION_N9.json");
if (existsSync(forbiddenRealGrant)) throw new Error("REAL_RESEARCHER_GRANT_MATERIALIZED_DURING_CLOSURE");
console.log("EVO_FRESH_N9_GRANT_RUNTIME_ADAPTER_CLOSURE_VERIFIED"); console.log(`requestContentHash=${request.contentHash}`);
console.log(`requestFileSha256=${sha(resolve(root, "13_FRESH_AUTHORIZATION_REQUEST.json"))}`); console.log(`requiredBindingsCount=${request.requiredBindingsCount}`);
console.log("providerCalls=0 modelCalls=0 secretReads=0 freshNormalCalls=0 freshCausalCalls=0 paidDockerLaunches=0");
