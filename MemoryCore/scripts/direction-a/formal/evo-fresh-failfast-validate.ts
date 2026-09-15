/** Dynamic zero-provider proof that normalized n4 reports the full frozen case ratio. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { canonicalJson, hashCanonical } from "../../../src/evaluation/direction-a/formal/core/canonical.js";
import { normalizeFailFastCaseAccountingVerifier, type FreshDenominatorQualification }
  from "../../../src/evaluation/direction-a/formal/evo-fresh/failfast-case-accounting.js";
import { assertFreshExactManifest, type FreshExactManifest }
  from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-manifest.js";

const repoRoot = resolve(process.cwd()); const workspaceRoot = resolve(repoRoot, "..");
const closureRoot = resolve(workspaceRoot, "Direction_A_Evo_Fresh_FailFast_Measurement_Closure_v1");
const priorRoot = resolve(workspaceRoot, "Direction_A_Evo_Fresh_Transitive_Binding_Closure_v2");
const outputPath = resolve(closureRoot, "06_ANTI_CENSORING_REGRESSION.json");
const sourceRoot = resolve(repoRoot, ".research/direction-a/v6.3/dependencies/evocodebench_wotraj");
const docker = "C:/Program Files/Docker/Docker/resources/bin/docker.exe";
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
function run(args: string[], capture = false): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(docker, args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"] });
  if (result.error) throw result.error;
  return { status: result.status ?? 255, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function must(args: string[], capture = false): string {
  const result = run(args, capture); if (result.status !== 0) throw new Error(`FRESH_FAILFAST_DYNAMIC_COMMAND_FAILED:${args[0]}:${result.stderr.trim()}`);
  return result.stdout;
}
function copy(source: string, container: string, destination: string): void {
  must(["exec", container, "bash", "-lc", `rm -rf '${destination}' && mkdir -p '${destination}'`]);
  must(["cp", `${source}/.`, `${container}:${destination}`]);
}
function verifier(container: string, label: string): { totalCases: number; successCount: number; failCount: number; reward: string; outputSha256: string } {
  const result = run(["exec", container, "bash", "-lc",
    `rm -f /tmp/${label}.out /tmp/${label}.err /logs/verifier/reward.txt; bash /tests/test.sh >/tmp/${label}.out 2>/tmp/${label}.err </dev/null`], true);
  const stdout = must(["exec", container, "cat", `/tmp/${label}.out`], true);
  const reward = must(["exec", container, "bash", "-lc", "cat /logs/verifier/reward.txt"], true).trim();
  must(["exec", container, "bash", "-lc",
    "test -s /logs/verifier/reward.txt && ps -eo pid=,ppid=,stat=,comm= | awk '$2 == 1 && $3 !~ /^Z/ && $4 != \"sleep\" {print $1}' | xargs -r kill 2>/dev/null || true"]);
  if (result.status !== 0) throw new Error(`FRESH_FAILFAST_DYNAMIC_VERIFIER_EXIT:${label}:${result.status}`);
  const summary = stdout.match(/^CASE_SUMMARY total_cases=(\d+) success_count=(\d+) fail_count=(\d+)$/m);
  const rows = [...stdout.matchAll(/^CASE_RESULT .* status=(success|fail) .* scenario="([^"]+)"/gm)];
  if (!summary || rows.length !== Number(summary[1]) || new Set(rows.map((row) => row[2])).size !== rows.length
    || rows.filter((row) => row[1] === "success").length !== Number(summary[2])
    || rows.filter((row) => row[1] === "fail").length !== Number(summary[3])) {
    throw new Error(`CORE_DECISION_REQUIRED_FAILFAST_CASE_RATIO_UNRECOVERABLE:${label}`);
  }
  return { totalCases: Number(summary[1]), successCount: Number(summary[2]), failCount: Number(summary[3]), reward, outputSha256: sha(stdout) };
}

const exact = readJson<FreshExactManifest>(resolve(priorRoot, "frozen/post-t1/FRESH_EXACT_MANIFEST_FREEZE.json")); assertFreshExactManifest(exact);
const qualification = readJson<FreshDenominatorQualification>(resolve(closureRoot, "01_FRESH_N9_DENOMINATOR_QUALIFICATION.json"));
const identity = exact.sourceInventory[3]; const qualified = qualification.entries[3];
if (!identity || !qualified || identity.prefixIndex !== 4 || qualified.taskId !== identity.taskId || !qualified.failFastNormalization) {
  throw new Error("FRESH_FAILFAST_DYNAMIC_N4_QUALIFICATION_MISSING");
}
const source = resolve(sourceRoot, identity.taskId); const native = readFileSync(resolve(source, `steps/round-${identity.targetRound}/tests/test.sh`), "utf8");
const normalized = normalizeFailFastCaseAccountingVerifier(native);
if (normalized.totalCases !== qualified.qualifiedTotalCases || normalized.normalizedVerifierSha256 !== qualified.failFastNormalization.normalizedVerifierSha256) {
  throw new Error("FRESH_FAILFAST_DYNAMIC_NORMALIZATION_DRIFT");
}
const temp = mkdtempSync(resolve(tmpdir(), "fresh-n4-ant904-")); const tests = resolve(temp, "tests"); mkdirSync(tests);
writeFileSync(resolve(tests, "test.sh"), normalized.normalizedSource, "utf8");
const container = `fresh-n4-ant904-${process.pid}`; const image = "direction-a-evo-fresh-denominator-v1-n4";
try {
  must(["create", "--name", container, image, "sleep", "infinity"]); must(["start", container]);
  for (let round = 1; round <= identity.sourceMemoryRound; round += 1) {
    copy(resolve(source, `steps/round-${round}/solution`), container, "/solution"); must(["exec", container, "bash", "/solution/solve.sh"]);
    copy(resolve(source, `steps/round-${round}/tests`), container, "/tests");
    const nativeRound = run(["exec", container, "bash", "-lc", `bash /tests/test.sh >/tmp/r${round}.out 2>/tmp/r${round}.err </dev/null`], true);
    if (nativeRound.status !== 0 || !/^1(?:\.0)?$/m.test(must(["exec", container, "cat", "/logs/verifier/reward.txt"], true).trim())) {
      throw new Error(`FRESH_FAILFAST_DYNAMIC_PREFIX_REPLAY_FAILED:round-${round}`);
    }
  }
  copy(tests, container, "/tests"); const prefix = verifier(container, "normalized-prefix");
  if (prefix.totalCases !== normalized.totalCases || prefix.failCount < 1
    || prefix.successCount + prefix.failCount !== normalized.totalCases || prefix.reward !== "0") {
    throw new Error("CORE_DECISION_REQUIRED_FAILFAST_CASE_RATIO_UNRECOVERABLE:PREFIX_COUNTS");
  }
  copy(resolve(source, `steps/round-${identity.targetRound}/solution`), container, "/solution"); must(["exec", container, "bash", "/solution/solve.sh"]);
  copy(tests, container, "/tests"); const oracle = verifier(container, "normalized-oracle");
  if (oracle.totalCases !== normalized.totalCases || oracle.successCount !== normalized.totalCases
    || oracle.failCount !== 0 || !/^1(?:\.0)?$/.test(oracle.reward)) {
    throw new Error("CORE_DECISION_REQUIRED_FAILFAST_CASE_RATIO_UNRECOVERABLE:ORACLE_COUNTS");
  }
  const body = { schemaVersion: "direction-a.evo-fresh-anti-censoring-dynamic-proof.v1", taskId: identity.taskId,
    frozenInventoryChanged: false, testCommandsInputsAssertionsChanged: false, genericRewardZeroMappingUsed: false,
    normalizedVerifierSha256: normalized.normalizedVerifierSha256, registeredCaseCount: normalized.totalCases,
    arms: ["NORMAL", "FULL", "REMOVE"], identicalVerifierBytesAcrossArmsRequired: true, prefix, oracle,
    providerCalls: 0, modelCalls: 0, paidAgentDispatches: 0, secretReads: 0 };
  const document = { ...body, contentHash: hashCanonical(body) }; const bytes = `${canonicalJson(document)}\n`;
  if (existsSync(outputPath)) { if (readFileSync(outputPath, "utf8") !== bytes) throw new Error("IMMUTABLE_OUTPUT_DRIFT:06_ANTI_CENSORING_REGRESSION.json"); }
  else { if (process.argv.includes("--check")) throw new Error("DETERMINISTIC_REPLAY_MISSING:06_ANTI_CENSORING_REGRESSION.json");
    mkdirSync(dirname(outputPath), { recursive: true }); writeFileSync(outputPath, bytes, { flag: "wx" }); }
  console.log(`FRESH_FAILFAST_CASE_RATIO_RECOVERED:${prefix.successCount}/${normalized.totalCases}`);
  console.log("providerCalls=0 modelCalls=0 paidAgentDispatches=0 secretReads=0");
} finally {
  try { must(["rm", "-f", container], true); } catch { /* exact temporary container only */ }
  rmSync(temp, { recursive: true, force: true });
}
