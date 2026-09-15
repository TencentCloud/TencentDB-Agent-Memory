/** Zero-provider all-N9 prefix/oracle structural denominator qualification. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { canonicalJson, hashCanonical } from "../../../src/evaluation/direction-a/formal/core/canonical.js";
import { assertFreshExactManifest, type FreshExactManifest } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-manifest.js";
import { FRESH_DENOMINATOR_PROTOCOL_VERSION, assertFreshDenominatorQualification,
  normalizeFailFastCaseAccountingVerifier, type FreshDenominatorQualification,
  type FreshDenominatorQualificationEntry } from "../../../src/evaluation/direction-a/formal/evo-fresh/failfast-case-accounting.js";

const repoRoot = resolve(process.cwd());
const workspaceRoot = resolve(repoRoot, "..");
const arg = (name: string): string | undefined => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const priorClosureRoot = resolve(arg("--prior-closure-root") ?? resolve(workspaceRoot, "Direction_A_Evo_Fresh_Transitive_Binding_Closure_v2"));
const outputRoot = resolve(arg("--output-root") ?? resolve(workspaceRoot, "Direction_A_Evo_Fresh_FailFast_Measurement_Closure_v1"));
const outputPath = resolve(outputRoot, "01_FRESH_N9_DENOMINATOR_QUALIFICATION.json");
const docker = "C:/Program Files/Docker/Docker/resources/bin/docker.exe";
const sourceRoot = resolve(repoRoot, ".research/direction-a/v6.3/dependencies/evocodebench_wotraj");
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  .flatMap((entry) => entry.isDirectory() ? files(resolve(directory, entry.name)) : entry.isFile() ? [resolve(directory, entry.name)] : []);
const dirHash = (directory: string): string => { const hash = createHash("sha256"); for (const path of files(directory)) {
  hash.update(relative(directory, path).replaceAll("\\", "/")); hash.update("\0"); hash.update(readFileSync(path)); hash.update("\0");
} return hash.digest("hex"); };
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

function dockerRun(args: string[], capture = false): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(docker, args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"] });
  if (result.error) throw result.error;
  return { status: result.status ?? 255, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function mustDocker(args: string[], capture = false): string {
  const result = dockerRun(args, capture);
  if (result.status !== 0) throw new Error(`FRESH_DENOMINATOR_DOCKER_COMMAND_FAILED:${args[0]}:${result.status}:${result.stderr.trim()}`);
  return result.stdout;
}
function buildQualificationImage(image: string, context: string): void {
  if (!image.endsWith("-n8") && !image.endsWith("-n9")) {
    let nativeLast: ReturnType<typeof dockerRun> | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      nativeLast = dockerRun(["build", "-t", image, context]);
      if (nativeLast.status === 0) return;
      console.error(`FRESH_DENOMINATOR_DOCKER_BUILD_RETRY:${image}:${attempt}_OF_3`);
    }
    throw new Error(`FRESH_DENOMINATOR_DOCKER_BUILD_FAILED_AFTER_RETRIES:${image}:${nativeLast?.status ?? 255}:${nativeLast?.stderr.trim() ?? ""}`);
  }
  const buildContext = mkdtempSync(resolve(tmpdir(), "fresh-denominator-build-"));
  try {
    cpSync(context, buildContext, { recursive: true });
    const dockerfilePath = resolve(buildContext, "Dockerfile");
    const nativeDockerfile = readFileSync(dockerfilePath, "utf8");
    const retryDockerfile = nativeDockerfile.replace("apt-get update",
      "sed -i 's|http://archive.ubuntu.com/ubuntu|http://mirrors.aliyun.com/ubuntu|g; s|http://security.ubuntu.com/ubuntu|http://mirrors.aliyun.com/ubuntu|g' /etc/apt/sources.list && apt-get -o Acquire::Retries=8 -o Acquire::http::Timeout=30 update")
      .replaceAll("apt-get install", "apt-get -o Acquire::Retries=8 -o Acquire::http::Timeout=30 install");
    writeFileSync(dockerfilePath, retryDockerfile, "utf8");
    let last: ReturnType<typeof dockerRun> | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      last = dockerRun(["build", "-t", image, buildContext]);
      if (last.status === 0) return;
      console.error(`FRESH_DENOMINATOR_DOCKER_BUILD_RETRY:${image}:${attempt}_OF_3`);
    }
    throw new Error(`FRESH_DENOMINATOR_DOCKER_BUILD_FAILED_AFTER_RETRIES:${image}:${last?.status ?? 255}:${last?.stderr.trim() ?? ""}`);
  } finally {
    rmSync(buildContext, { recursive: true, force: true });
  }
}
function copyDirectoryToContainer(source: string, container: string, destination: string): void {
  mustDocker(["exec", container, "bash", "-lc", `rm -rf '${destination}' && mkdir -p '${destination}'`]);
  mustDocker(["cp", `${source}/.`, `${container}:${destination}`]);
}
function cleanupOrphanedTestProcesses(container: string): void {
  mustDocker(["exec", container, "bash", "-lc",
    "test -s /logs/verifier/reward.txt && ps -eo pid=,ppid=,stat=,comm= | awk '$2 == 1 && $3 !~ /^Z/ && $4 != \"sleep\" {print $1}' | xargs -r kill 2>/dev/null || true"]);
}
function runVerifier(container: string, label: string): { totalCases: number | null; reward: string; exitStatus: number; stdoutSha256: string; stderrSha256: string } {
  const stdoutPath = `/tmp/${label}.stdout`; const stderrPath = `/tmp/${label}.stderr`;
  const result = dockerRun(["exec", container, "bash", "-lc",
    `rm -f '${stdoutPath}' '${stderrPath}' /logs/verifier/reward.txt; bash /tests/test.sh >'${stdoutPath}' 2>'${stderrPath}' </dev/null`], true);
  const stdout = mustDocker(["exec", container, "bash", "-lc", `cat '${stdoutPath}'`], true);
  const stderr = mustDocker(["exec", container, "bash", "-lc", `cat '${stderrPath}'`], true);
  const reward = mustDocker(["exec", container, "bash", "-lc", "cat /logs/verifier/reward.txt 2>/dev/null || true"], true).trim();
  cleanupOrphanedTestProcesses(container);
  const matches = [...stdout.matchAll(/^CASE_SUMMARY\s+total_cases=(\d+)\s+success_count=(\d+)\s+fail_count=(\d+)\s*$/gm)];
  if (matches.length > 1) throw new Error(`FRESH_DENOMINATOR_DUPLICATE_SUMMARY:${label}`);
  const totalCases = matches.length === 1 ? Number(matches[0][1]) : null;
  return { totalCases, reward, exitStatus: result.status,
    stdoutSha256: sha(`STRUCTURAL_OUTPUT|totalCases=${totalCases ?? "null"}|reward=${reward}|exitStatus=${result.status}`),
    stderrSha256: sha("NON_STRUCTURAL_STDERR_EXCLUDED_FROM_QUALIFICATION") };
}

const exact = readJson<FreshExactManifest>(resolve(priorClosureRoot, "frozen/post-t1/FRESH_EXACT_MANIFEST_FREEZE.json"));
assertFreshExactManifest(exact);
if (process.argv.includes("--canonicalize-existing-after-verified-replay")) {
  const existing = readJson<FreshDenominatorQualification>(outputPath);
  const entries = existing.entries.map((entry) => ({ ...entry,
    prefix: { ...entry.prefix,
      stdoutSha256: sha(`STRUCTURAL_OUTPUT|totalCases=${entry.prefix.totalCases ?? "null"}|reward=${entry.prefix.reward}|exitStatus=${entry.prefix.exitStatus}`),
      stderrSha256: sha("NON_STRUCTURAL_STDERR_EXCLUDED_FROM_QUALIFICATION") },
    oracle: { ...entry.oracle,
      stdoutSha256: sha(`STRUCTURAL_OUTPUT|totalCases=${entry.oracle.totalCases}|reward=${entry.oracle.reward}|exitStatus=${entry.oracle.exitStatus}`),
      stderrSha256: sha("NON_STRUCTURAL_STDERR_EXCLUDED_FROM_QUALIFICATION") } }));
  const { contentHash: _old, ...oldBody } = existing; const body = { ...oldBody, entries };
  const normalized = { ...body, contentHash: hashCanonical(body) } as FreshDenominatorQualification;
  assertFreshDenominatorQualification(normalized, exact); writeFileSync(outputPath, `${canonicalJson(normalized)}\n`, "utf8");
  console.log(`FRESH_DENOMINATOR_QUALIFICATION_CANONICALIZED:${normalized.contentHash}`); process.exit(0);
}
if (existsSync(outputPath) && !process.argv.includes("--check")) throw new Error(`IMMUTABLE_OUTPUT_EXISTS:${outputPath}`);
const tempRoot = mkdtempSync(resolve(tmpdir(), "fresh-n9-denominator-v1-"));
const entries: FreshDenominatorQualificationEntry[] = [];
try {
  for (const identity of exact.sourceInventory) {
    const source = resolve(sourceRoot, identity.taskId);
    if (dirHash(source) !== identity.sourceTaskDirectoryHash) throw new Error(`FRESH_SOURCE_TASK_DIRECTORY_HASH_MISMATCH:${identity.taskId}`);
    const targetTests = resolve(source, `steps/round-${identity.targetRound}/tests`);
    const targetSolution = resolve(source, `steps/round-${identity.targetRound}/solution`);
    const nativeVerifier = readFileSync(resolve(targetTests, "test.sh"), "utf8");
    const targetSolve = readFileSync(resolve(targetSolution, "solve.sh"), "utf8");
    const image = `direction-a-evo-fresh-denominator-v1-n${identity.prefixIndex}`;
    const container = `fresh-denominator-v1-n${identity.prefixIndex}-${process.pid}`;
    const prefixApp = resolve(tempRoot, `n${identity.prefixIndex}`, "prefix-app");
    mkdirSync(prefixApp, { recursive: true });
    buildQualificationImage(image, resolve(source, "environment"));
    try {
      mustDocker(["create", "--name", container, image, "sleep", "infinity"]); mustDocker(["start", container]);
      for (let round = 1; round <= identity.sourceMemoryRound; round += 1) {
        copyDirectoryToContainer(resolve(source, `steps/round-${round}/solution`), container, "/solution");
        mustDocker(["exec", container, "bash", "/solution/solve.sh"]);
        copyDirectoryToContainer(resolve(source, `steps/round-${round}/tests`), container, "/tests");
        const prefixRound = runVerifier(container, `prefix-round-${round}`);
        if (prefixRound.exitStatus !== 0 || !/^1(?:\.0)?$/.test(prefixRound.reward)) {
          throw new Error(`FRESH_PREFIX_REPLAY_INVALID:${identity.taskId}:round-${round}`);
        }
      }
      mustDocker(["cp", `${container}:/app/.`, prefixApp]);
      copyDirectoryToContainer(targetTests, container, "/tests");
      const prefix = runVerifier(container, "target-prefix");
      mustDocker(["exec", container, "bash", "-lc", "rm -rf /app && mkdir -p /app"]);
      mustDocker(["cp", `${prefixApp}/.`, `${container}:/app`]);
      copyDirectoryToContainer(targetSolution, container, "/solution");
      mustDocker(["exec", container, "bash", "/solution/solve.sh"]);
      copyDirectoryToContainer(targetTests, container, "/tests");
      const oracleRaw = runVerifier(container, "target-oracle");
      if (oracleRaw.exitStatus !== 0 || oracleRaw.totalCases === null || !/^1(?:\.0)?$/.test(oracleRaw.reward)) {
        throw new Error(`FRESH_ORACLE_STRUCTURAL_DENOMINATOR_INVALID:${identity.taskId}`);
      }
      let classification: FreshDenominatorQualificationEntry["classification"];
      let failFastNormalization: FreshDenominatorQualificationEntry["failFastNormalization"] = null;
      if (prefix.totalCases === null) {
        const normalized = normalizeFailFastCaseAccountingVerifier(nativeVerifier);
        if (normalized.totalCases !== oracleRaw.totalCases) throw new Error(`CORE_DECISION_REQUIRED_FAILFAST_CASE_INVENTORY_MISMATCH:${identity.taskId}`);
        classification = "PREFIX_FAILFAST_ORACLE_STRUCTURAL_FALLBACK";
        failFastNormalization = { version: normalized.version, normalizedVerifierSha256: normalized.normalizedVerifierSha256,
          registeredCaseCount: normalized.totalCases };
      } else {
        if (prefix.totalCases !== oracleRaw.totalCases) throw new Error(`CORE_DECISION_REQUIRED_DENOMINATOR_STRUCTURAL_MISMATCH:${identity.taskId}`);
        classification = "PREFIX_ORACLE_MATCH";
      }
      entries.push({ prefixIndex: identity.prefixIndex, taskId: identity.taskId,
        canonicalCausalGroupId: identity.canonicalCausalGroupId, targetRound: identity.targetRound,
        sourceTaskDirectoryHash: identity.sourceTaskDirectoryHash, targetTestsDirectoryHash: dirHash(targetTests),
        nativeVerifierSha256: sha(nativeVerifier.replaceAll("\r\n", "\n")), targetSolutionSha256: sha(targetSolve),
        prefix, oracle: { ...oracleRaw, totalCases: oracleRaw.totalCases }, qualifiedTotalCases: oracleRaw.totalCases,
        classification, failFastNormalization });
      console.log(`FRESH_DENOMINATOR_QUALIFIED:n${identity.prefixIndex}:${oracleRaw.totalCases}:${classification}`);
    } finally { dockerRun(["rm", "-f", container], true); }
  }
  const body = { schemaVersion: FRESH_DENOMINATOR_PROTOCOL_VERSION, exactManifestHash: exact.contentHash,
    qualificationScope: "ALL_FRESH_N9_ZERO_PROVIDER" as const, oracleUse: "PRE_Y_STRUCTURAL_DENOMINATOR_ONLY" as const,
    oracleBytesInAgentWorkspace: false as const, oracleOutputInCheapX: false as const, entries,
    providerCalls: 0 as const, modelCalls: 0 as const, paidAgentDispatches: 0 as const, secretReads: 0 as const };
  const qualification = { ...body, contentHash: hashCanonical(body) } as FreshDenominatorQualification;
  assertFreshDenominatorQualification(qualification, exact);
  const bytes = `${canonicalJson(qualification)}\n`;
  if (existsSync(outputPath)) {
    if (readFileSync(outputPath, "utf8") !== bytes) throw new Error("DETERMINISTIC_REPLAY_DENOMINATOR_QUALIFICATION_DRIFT");
  } else {
    mkdirSync(dirname(outputPath), { recursive: true }); writeFileSync(outputPath, bytes, { flag: "wx" });
  }
  console.log(`FRESH_DENOMINATOR_QUALIFICATION_PASS:${entries.length}_OF_${exact.sourceInventory.length}`);
  console.log(`contentHash=${qualification.contentHash}`);
  console.log("providerCalls=0 modelCalls=0 paidAgentDispatches=0 secretReads=0");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
