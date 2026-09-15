/** Authorized, zero-provider N=9 materializer. This script prepares Docker task bytes but never reads model/provider secrets. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { type RealExecutionProfile } from "../../../src/evaluation/direction-a/formal/acquisition/execution-profile.js";
import { createPairSchedule } from "../../../src/evaluation/direction-a/formal/acquisition/integrity.js";
import { canonicalJson, hashCanonical } from "../../../src/evaluation/direction-a/formal/core/canonical.js";
import { assertFreshAuthorizationRequest, createFreshImmutableGrant,
  type FreshAuthorizationRequest, type FreshImmutableGrant } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-execution-gate.js";
import { FRESH_RUNTIME_ROOT, assertFreshExactManifest, assertFreshPreparedExecutionManifest, assertFreshPreparedRuntimeBytes,
  type FreshExactManifest, type FreshPreparedExecutionManifest, type FreshPreparedGroup } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-manifest.js";
import { verifyFreshRequiredBindings } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-binding-verification.js";
import { assertN3PrefixEnvironmentManifest, N3_PREFIX_ENVIRONMENT_ARTIFACT_PATH,
  type N3PrefixEnvironmentManifest } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-prefix-environment-recovery.js";
import { assertFreshDenominatorQualification, normalizeFailFastCaseAccountingVerifier,
  type FreshDenominatorQualification } from "../../../src/evaluation/direction-a/formal/evo-fresh/failfast-case-accounting.js";

const repoRoot = resolve(process.cwd()); const workspaceRoot = resolve(repoRoot, "..");
const arg = (name: string): string | undefined => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const closureRoot = resolve(arg("--closure-root") ?? resolve(workspaceRoot, "Direction_A_Evo_Fresh_FinalRecovery_Closure_v1"));
const runtimeRoot = FRESH_RUNTIME_ROOT; const preparedRoot = resolve(runtimeRoot, "prepared");
const sourceRoot = resolve(repoRoot, ".research/direction-a/v6.3/dependencies/evocodebench_wotraj");
const docker = "C:/Program Files/Docker/Docker/resources/bin/docker.exe";
const profilePath = resolve(repoRoot, ".research/direction-a/current-formal/pilot/manifests/real-execution-profile-v3.json");
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  .flatMap((entry) => entry.isDirectory() ? files(resolve(directory, entry.name)) : entry.isFile() ? [resolve(directory, entry.name)] : []);
const dirHash = (directory: string): string => { const hash = createHash("sha256"); for (const path of files(directory)) {
  hash.update(relative(directory, path).replaceAll("\\", "/")); hash.update("\0"); hash.update(readFileSync(path)); hash.update("\0");
} return hash.digest("hex"); };
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const writeJson = (path: string, value: unknown): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${canonicalJson(value)}\n`, "utf8"); };
const dockerExec = (args: string[], capture = false): string => execFileSync(docker, args, { cwd: repoRoot, encoding: "utf8",
  stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"], maxBuffer: 64 * 1024 * 1024 }) as string;
const dockerReady = (): boolean => { try { dockerExec(["info", "--format", "{{.ServerVersion}}"], true); return true; } catch { return false; } };
const runPrefixVerifier = (container: string, round: number): void => {
  dockerExec(["exec", container, "bash", "-lc",
    `rm -f /tmp/prepare-r${round}.out /tmp/prepare-r${round}.err /logs/verifier/reward.txt; bash /tests/test.sh >/tmp/prepare-r${round}.out 2>/tmp/prepare-r${round}.err </dev/null`], true);
  const reward = dockerExec(["exec", container, "bash", "-lc", "cat /logs/verifier/reward.txt 2>/dev/null || true"], true).trim();
  if (!/^1(?:\.0)?$/.test(reward)) throw new Error(`FRESH_PREFIX_REPLAY_COMPLETION_UNPROVEN:round-${round}`);
  dockerExec(["exec", container, "bash", "-lc",
    "test -s /logs/verifier/reward.txt && ps -eo pid=,ppid=,stat=,comm= | awk '$2 == 1 && $3 !~ /^Z/ && $4 != \"sleep\" {print $1}' | xargs -r kill 2>/dev/null || true"], true);
};
const normalizedMemory = (instruction: string): string => `Prior round requirements retained for target-round maintenance:\n${instruction.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim().slice(0, 3500)}`;
const taskToml = (name: string, taskId: string, targetRound: number, arm: string): string => `schema_version = "1.2"\nmulti_step_reward_strategy = "mean"\n\n[metadata]\nname = "${name}"\nversion = "3.0.0-evo-fresh-n9-fixed4"\ncategory = "direction-a-evo-fresh-n9"\nsource_task = "${taskId}"\ntarget_round = "round-${targetRound}"\ncausal_arm = "${arm}"\nscientific_use = "EVO_FRESH_ENGINEERING_HOLDOUT"\n\n[verifier]\ntimeout_sec = 1800\n\n[agent]\ntimeout_sec = 1800\n\n[environment]\nbuild_timeout_sec = 900\ncpus = 2\nmemory_mb = 4096\nstorage_mb = 10240\n\n[[steps]]\nname = "target-round"\n`;

const request = readJson<FreshAuthorizationRequest>(resolve(arg("--request") ?? resolve(closureRoot, "10_NEW_FRESH_AUTHORIZATION_REQUEST.json")));
const prefixEnvironment = readJson<N3PrefixEnvironmentManifest>(resolve(arg("--prefix-environment") ?? resolve(closureRoot, "06_N3_PREFIX_ENVIRONMENT_MANIFEST.json")));
const exact = readJson<FreshExactManifest>(resolve(arg("--exact") ?? resolve(closureRoot, "02_ACTIVE_PREFIX5_EXACT_MANIFEST.json")));
const qualification = readJson<FreshDenominatorQualification>(resolve(arg("--qualification")
  ?? resolve(closureRoot, "03_ACTIVE_PREFIX5_DENOMINATOR_RESTRICTION.json")));
const profile = readJson<RealExecutionProfile>(profilePath); const grantPath = resolve(arg("--grant") ?? resolve(closureRoot, "authorization/FRESH_AUTHORIZATION_N9.json"));
if (!existsSync(grantPath)) throw new Error("FRESH_PREPARE_REQUIRES_IMMUTABLE_GRANT");
const grant = readJson<FreshImmutableGrant>(grantPath);
assertFreshAuthorizationRequest(request); assertFreshExactManifest(exact); assertFreshDenominatorQualification(qualification, exact);
assertN3PrefixEnvironmentManifest(repoRoot, prefixEnvironment);
verifyFreshRequiredBindings(workspaceRoot, request);
const replay = createFreshImmutableGrant({ request, exact, profile, approvalText: grant.approvalText });
if (replay.contentHash !== grant.contentHash) throw new Error("FRESH_PREPARE_GRANT_REPLAY_MISMATCH");
if (process.argv.includes("--docker-readiness")) { console.log(dockerReady() ? "DOCKER_READY" : "DOCKER_UNAVAILABLE"); process.exit(0); }
if (!dockerReady()) throw new Error("FRESH_PREPARE_DOCKER_UNAVAILABLE");
if (existsSync(preparedRoot)) throw new Error(`FRESH_PREPARATION_ALREADY_FROZEN:${preparedRoot}`);

mkdirSync(runtimeRoot, { recursive: true }); const staging = resolve(runtimeRoot, `.staging-prepared-${process.pid}`);
mkdirSync(staging, { recursive: false }); const groups: FreshPreparedGroup[] = [];
try {
  for (const identity of exact.sourceInventory) {
    const source = resolve(repoRoot, identity.sourceTaskRelativePath); const slug = `n${identity.prefixIndex}`;
    const sourceMemoryRound = identity.targetRound - 1;
    const required = [source, resolve(source, "task.toml"), resolve(source, "environment/Dockerfile"),
      resolve(source, `steps/round-${sourceMemoryRound}/instruction.md`), resolve(source, `steps/round-${identity.targetRound}/instruction.md`),
      resolve(source, `steps/round-${identity.targetRound}/tests`)];
    if (required.some((path) => !existsSync(path))) throw new Error(`FRESH_PREPARATION_SOURCE_MISSING:${identity.taskId}`);
    if (dirHash(source) !== identity.sourceTaskDirectoryHash) throw new Error(`FRESH_SOURCE_TASK_DIRECTORY_HASH_MISMATCH:${identity.taskId}`);
    const image = `direction-a-evo-fresh-n9-${slug}-source`; const container = `direction-a-evo-fresh-n9-${slug}-${process.pid}`;
    dockerExec(["build", "-t", image, resolve(source, "environment")]); mkdirSync(resolve(staging, slug, "prefix-app"), { recursive: true });
    const qualificationEntry = qualification.entries[identity.prefixIndex - 1];
    if (!qualificationEntry || qualificationEntry.taskId !== identity.taskId) throw new Error(`FRESH_DENOMINATOR_QUALIFICATION_IDENTITY_MISMATCH:${identity.taskId}`);
    const frozenTotalCases = qualificationEntry.qualifiedTotalCases;
    let externalPrefixArtifacts: Array<{ targetPath: string; relativePath: string; sha256: string; requiredExecutable: true }> = [];
    try {
      dockerExec(["create", "--name", container, image, "sleep", "infinity"]); dockerExec(["start", container]);
      for (let round = 1; round <= sourceMemoryRound; round += 1) {
        const solution = resolve(source, `steps/round-${round}/solution`); const tests = resolve(source, `steps/round-${round}/tests`);
        if (!existsSync(resolve(solution, "solve.sh")) || !existsSync(resolve(tests, "test.sh"))) throw new Error(`FRESH_ORACLE_PREFIX_SOURCE_MISSING:${identity.taskId}:round-${round}`);
        dockerExec(["exec", container, "bash", "-lc", "rm -rf /solution /tests && mkdir -p /solution /tests"]);
        dockerExec(["cp", `${solution}/.`, `${container}:/solution`]); dockerExec(["exec", container, "bash", "/solution/solve.sh"]);
        dockerExec(["cp", `${tests}/.`, `${container}:/tests`]); runPrefixVerifier(container, round);
      }
      dockerExec(["cp", `${container}:/app/.`, resolve(staging, slug, "prefix-app")]);
      if (identity.prefixIndex === 3) {
        const relativePath = "external-prefix-artifacts/usr/local/bin/flowr";
        const destination = resolve(staging, slug, relativePath);
        mkdirSync(dirname(destination), { recursive: true });
        const containerHash = dockerExec(["exec", container, "bash", "-lc",
          `test -x ${N3_PREFIX_ENVIRONMENT_ARTIFACT_PATH} && sha256sum ${N3_PREFIX_ENVIRONMENT_ARTIFACT_PATH} | awk '{print $1}'`], true).trim();
        if (!/^[a-f0-9]{64}$/.test(containerHash)) throw new Error("CORE_DECISION_REQUIRED_N3_PREFIX_ENVIRONMENT_PROVENANCE:artifact-missing");
        dockerExec(["cp", `${container}:${N3_PREFIX_ENVIRONMENT_ARTIFACT_PATH}`, destination]);
        const copiedHash = sha(readFileSync(destination));
        if (copiedHash !== containerHash) throw new Error("FRESH_PREFIX_EXTERNAL_ARTIFACT_HASH_MISMATCH");
        externalPrefixArtifacts = [{ targetPath: N3_PREFIX_ENVIRONMENT_ARTIFACT_PATH, relativePath, sha256: copiedHash, requiredExecutable: true }];
      }
    } finally { try { dockerExec(["rm", "-f", container], true); } catch { /* exact temporary container only */ } }
    const targetInstruction = readFileSync(resolve(source, `steps/round-${identity.targetRound}/instruction.md`), "utf8");
    const memory = normalizedMemory(readFileSync(resolve(source, `steps/round-${sourceMemoryRound}/instruction.md`), "utf8"));
    const injected = `<memory_context source="${identity.taskId}:round-${sourceMemoryRound}">\n${memory}\n</memory_context>`;
    const treatedInstruction = `${injected}\n\n${targetInstruction}`; const taskPaths = { NORMAL: "", FULL: "", REMOVE: "" };
    for (const arm of ["NORMAL", "FULL", "REMOVE"] as const) {
      const name = `evo-fresh-n9-${slug}-${arm.toLowerCase()}`; const task = resolve(staging, "tasks", name);
      cpSync(resolve(source, "environment"), resolve(task, "environment"), { recursive: true });
      cpSync(resolve(staging, slug, "prefix-app"), resolve(task, "environment/frozen-app"), { recursive: true });
      if (externalPrefixArtifacts.length) cpSync(resolve(staging, slug, "external-prefix-artifacts"), resolve(task, "environment/external-prefix-artifacts"), { recursive: true });
      mkdirSync(resolve(task, "steps/target-round"), { recursive: true });
      const sourceTests = resolve(source, `steps/round-${identity.targetRound}/tests`);
      const preparedTests = resolve(task, "steps/target-round/tests");
      cpSync(sourceTests, preparedTests, { recursive: true });
      if (qualificationEntry.failFastNormalization) {
        const nativeVerifierPath = resolve(preparedTests, "test.sh");
        const nativeVerifier = readFileSync(nativeVerifierPath, "utf8");
        const normalized = normalizeFailFastCaseAccountingVerifier(nativeVerifier);
        if (normalized.nativeVerifierSha256 !== qualificationEntry.nativeVerifierSha256
          || normalized.normalizedVerifierSha256 !== qualificationEntry.failFastNormalization.normalizedVerifierSha256
          || normalized.totalCases !== frozenTotalCases) throw new Error(`FRESH_FAILFAST_NORMALIZATION_QUALIFICATION_DRIFT:${identity.taskId}`);
        writeFileSync(nativeVerifierPath, normalized.normalizedSource, "utf8");
      }
      const dockerfile = readFileSync(resolve(task, "environment/Dockerfile"), "utf8");
      const externalDockerfile = externalPrefixArtifacts.map((artifact) => `COPY ${artifact.relativePath} ${artifact.targetPath}\nRUN test \"$(sha256sum ${artifact.targetPath} | awk '{print $1}')\" = \"${artifact.sha256}\" && chmod 0755 ${artifact.targetPath}`).join("\n");
      writeFileSync(resolve(task, "environment/Dockerfile"), `${dockerfile.trim()}\nRUN find /app -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +\nCOPY frozen-app/ /app/\n${externalDockerfile}\nRUN apt-get update && apt-get install -y --no-install-recommends tmux asciinema && rm -rf /var/lib/apt/lists/*\n`, "utf8");
      writeFileSync(resolve(task, "steps/target-round/instruction.md"), arm === "REMOVE" ? targetInstruction : treatedInstruction, "utf8");
      writeFileSync(resolve(task, "task.toml"), taskToml(name, identity.taskId, identity.targetRound, arm), "utf8");
      writeJson(resolve(task, "DIRECTION_A_TREATMENT.json"), { schemaVersion: "direction-a.evo-fresh-n9-treatment.v1", ...identity,
        sourceMemoryRound, arm, injectedCandidateHash: arm === "REMOVE" ? null : identity.taskCandidateHash, fixedPairCount: 4,
        technicalReplacementLimitPerTask: 2, pair5Forbidden: true });
      taskPaths[arm] = relative(repoRoot, resolve(preparedRoot, "tasks", name)).replaceAll("\\", "/");
    }
    const frozenPrefixHash = `state_${dirHash(resolve(staging, slug, "prefix-app")).slice(0, 24)}`;
    const recallSnapshotHash = `r0_${sha(injected).slice(0, 24)}`;
    const pairSchedule = createPairSchedule([1, 2, 3, 4], `direction-a-evo-fresh-n9-fixed4:${identity.canonicalCausalGroupId}`);
    const prepBody = { schemaVersion: "direction-a.evo-fresh-n9-group-preparation.v1", ...identity, sourceMemoryRound,
      frozenPrefixHash, recallSnapshotHash, targetGroupHash: identity.groupCandidateHash, pairSchedule, taskPaths,
      denominatorQualificationHash: qualification.contentHash, frozenTotalCases,
      caseAccounting: qualificationEntry.failFastNormalization, externalPrefixArtifacts,
      providerCalls: 0, modelCalls: 0, secretReads: 0 };
    const preparationArtifactHash = hashCanonical(prepBody); writeJson(resolve(staging, slug, "GROUP_PREPARATION.json"), { ...prepBody, contentHash: preparationArtifactHash });
    const nativeTargetTestsDirectoryHash = dirHash(resolve(source, `steps/round-${identity.targetRound}/tests`));
    const preparedTargetTestsDirectoryHash = dirHash(resolve(staging, "tasks", `evo-fresh-n9-${slug}-normal/steps/target-round/tests`));
    groups.push({ causalGroupId: identity.canonicalCausalGroupId, taskId: identity.taskId, statisticalClusterId: identity.statisticalClusterId,
      officialDomainId: identity.officialDomainId, targetRound: identity.targetRound, sourceMemoryRound, prefixIndex: identity.prefixIndex,
      taskCandidateHash: identity.taskCandidateHash, sourceTaskDirectoryHash: identity.sourceTaskDirectoryHash,
      groupCandidateHash: identity.groupCandidateHash, sourceEvidenceHash: identity.sourceEvidenceHash, selectionRole: "FRESH_N9_FIXED",
      deepReference: false, validPairMaximum: 4, validPairMinimum: 4, technicalRetryReserveTrials: 2, frozenTotalCases,
      normalTaskPath: taskPaths.NORMAL, fullTaskPath: taskPaths.FULL, removeTaskPath: taskPaths.REMOVE,
      normalTaskDirectoryHash: dirHash(resolve(staging, "tasks", `evo-fresh-n9-${slug}-normal`)),
      fullTaskDirectoryHash: dirHash(resolve(staging, "tasks", `evo-fresh-n9-${slug}-full`)),
      removeTaskDirectoryHash: dirHash(resolve(staging, "tasks", `evo-fresh-n9-${slug}-remove`)), frozenPrefixHash,
      targetGroupHash: identity.groupCandidateHash, recallSnapshotHash, guideNormalizationHash: sha("NORMALIZE_WHITESPACE_THEN_FIRST_3500_UNICODE_CODE_POINTS"),
      normalObservationRole: "CAUSAL_SUPERVISED_SOURCE_X", normalTreatmentAvailability: "SAME_FROZEN_AUTO_INJECTION_AS_FULL",
      normalCountsAsFullReplicate: false, normalInstructionHash: sha(treatedInstruction), fullInstructionHash: sha(treatedInstruction),
      controlledPreseedScope: "CONDITIONAL_INJECTION_EFFECT_ONLY_NO_NATURAL_WRITE_OR_TRANSPORT_CLAIM",
      technicalRetryScope: "PER_CAUSAL_GROUP_COMPLETE_UNIT_INCLUDING_NORMAL_AND_CAUSAL_ARMS", preparationArtifactHash, pairSchedule,
      targetInstructionHash: sha(targetInstruction), targetTestsDirectoryHash: preparedTargetTestsDirectoryHash,
      nativeTargetTestsDirectoryHash, preparedTargetTestsDirectoryHash,
      externalPrefixArtifacts, caseAccounting: qualificationEntry.failFastNormalization ? { version: qualificationEntry.failFastNormalization.version,
        nativeVerifierSha256: qualificationEntry.nativeVerifierSha256,
        normalizedVerifierSha256: qualificationEntry.failFastNormalization.normalizedVerifierSha256,
        registeredCaseCount: qualificationEntry.failFastNormalization.registeredCaseCount } : null });
  }
  const body = { schemaVersion: "direction-a.evo-fresh-n9-prepared-manifest.v3" as const, decisionId: exact.decisionId,
    stage: "EVO_FRESH_ENGINEERING_HOLDOUT" as const, runtimeRoot: FRESH_RUNTIME_ROOT, exactManifestHash: exact.contentHash,
    executionProfileHash: profile.contentHash, denominatorQualificationHash: qualification.contentHash,
    preparationProtocolHash: request.preparedManifestContractHash, prefixEnvironmentManifestHash: prefixEnvironment.contentHash, groups,
    preparationSemantics: { sourceMemoryRound: "TARGET_ROUND_MINUS_ONE" as const,
      normalAndFullTreatment: "SAME_FROZEN_AUTO_INJECTION" as const, removeTreatment: "NO_MEMORY_CONTEXT" as const,
      verifier: "EVOCODEBENCH_VERSIONED_COMPLETE_CASE_ACCOUNTING" as const, utility: "SUCCESS_COUNT_DIVIDED_BY_FROZEN_TOTAL_CASES" as const,
      technicalReplacementLimitPerTask: 2 as const, paidProviderCallsDuringPreparation: 0 as const },
    preparedByDriverSha256: sha(readFileSync(new URL(import.meta.url))) };
  const prepared = { ...body, contentHash: hashCanonical(body) } as FreshPreparedExecutionManifest;
  assertFreshPreparedExecutionManifest(prepared, exact); writeJson(resolve(staging, "FRESH_N9_PREPARED_EXECUTION_MANIFEST.json"), prepared);
  writeJson(resolve(staging, "FRESH_N9_PREPARE_REPORT.json"), { status: "READY_FOR_ZERO_PROVIDER_PREFLIGHT", providerCalls: 0,
    modelCalls: 0, secretReads: 0 }); renameSync(staging, preparedRoot); await assertFreshPreparedRuntimeBytes(repoRoot, prepared, exact);
  console.log("FRESH_N9_PREPARE_COMPLETE_ZERO_PROVIDER");
} catch (error) { if (existsSync(staging)) rmSync(staging, { recursive: true, force: true }); throw error; }
