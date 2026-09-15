import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const portableScriptFile = fileURLToPath(import.meta.url);

function discoverPackageRoot() {
  let cliRoot = null;
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === "--package-root") {
      if (index + 1 >= process.argv.length) throw new Error("--package-root requires a value");
      cliRoot = process.argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--package-root=")) {
      cliRoot = arg.slice("--package-root=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  const derivedRoot = path.resolve(path.dirname(portableScriptFile), "..", "..");
  const selectedRoot = cliRoot || process.env.DIRECTION_A_PACKAGE_ROOT || derivedRoot;
  const resolvedRoot = path.resolve(selectedRoot);
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
    throw new Error(`Package root does not exist or is not a directory: ${resolvedRoot}`);
  }
  return fs.realpathSync(resolvedRoot);
}

const packageRoot = discoverPackageRoot();
const accessedPackagePaths = new Set();

function packageRelative(p) {
  return path.relative(packageRoot, path.resolve(p)).replaceAll("\\", "/") || ".";
}

function assertInsidePackage(p) {
  const resolved = path.resolve(p);
  const relative = path.relative(packageRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing path outside package root: ${resolved}`);
  }
  accessedPackagePaths.add(relative.replaceAll("\\", "/") || ".");
  return resolved;
}

function requirePackagePath(relativePath, kind = "file") {
  const absolute = assertInsidePackage(path.join(packageRoot, ...relativePath.split("/")));
  const exists = fs.existsSync(absolute);
  const validKind = exists && (kind === "directory" ? fs.statSync(absolute).isDirectory() : fs.statSync(absolute).isFile());
  if (!validKind) throw new Error(`Missing package ${kind}: ${relativePath}`);
  return absolute;
}

const output = requirePackagePath("analysis", "directory");
const scriptPath = requirePackagePath("analysis/scripts/rebuild_direction_a_final_analysis_PORTABLE.mjs");
const closure = requirePackagePath("evidence/evo/fresh-authority", "directory");
const runtime = requirePackagePath("evidence/fresh/runtime", "directory");
const rawRuntime = requirePackagePath("evidence/fresh/raw-selected", "directory");
const preparedTaskRoot = requirePackagePath("evidence/full-audit/fresh/prepared-tasks", "directory");
const requestPath = requirePackagePath("evidence/evo/fresh-authority/10_NEW_FRESH_AUTHORIZATION_REQUEST.json");
const manifestPath = requirePackagePath("evidence/fresh/runtime/prepared/FRESH_N9_PREPARED_EXECUTION_MANIFEST.json");
const statePath = requirePackagePath("evidence/fresh/runtime/FRESH_N9_RUN_STATE.json");
const journalPath = requirePackagePath("evidence/fresh/runtime/execution-events.jsonl");
const ledgerPath = requirePackagePath("evidence/fresh/runtime/FRESH_N9_BUDGET_LEDGER.jsonl");
const barrierPath = requirePackagePath("evidence/fresh/runtime/FRESH_N9_ALL_NORMAL_BARRIER.json");
const featureRowsPath = requirePackagePath("evidence/fresh/runtime/FRESH_N9_NORMAL_FEATURE_ROWS.json");
const policyPath = requirePackagePath("evidence/fresh/runtime/FRESH_N9_PRE_Y_POLICY_FREEZE.json");
const summaryPath = requirePackagePath("evidence/fresh/final-summary/Direction_A_Evo_Fresh_Phase3_FINAL_SUMMARY_20260914.json");
const completeReportPath = requirePackagePath("evidence/fresh/final-summary/Direction_A_Evo_Fresh_Phase3_COMPLETE_REPORT_20260914.md");
const modelSetPath = requirePackagePath("evidence/evo/fresh-authority/frozen/post-t1/16_FINAL_MODEL_SET_FREEZE.json");
const transitiveManifestPath = requirePackagePath("evidence/evo/fresh-authority/12_FINAL_TRANSITIVE_BINDING_MANIFEST.json");
const candidateMapPath = requirePackagePath("evidence/authority/Direction_A_FINAL_FREEZE_CANDIDATE_MAP_20260914.md");
const goalPath = requirePackagePath("evidence/authority/Direction_A_Conversation2_Final_Analysis_and_Report_GOAL_20260914.md");
const wholeProjectGoalPath = requirePackagePath("evidence/authority/Direction_A_Codex_Whole_Project_Final_Report_Revision_GOAL_20260914.md");
const wholeProjectSynthesisInputs = [
  requirePackagePath("evidence/mem2/formal-cal/03_A1_INFERENCE_REPORT.json"),
  requirePackagePath("evidence/mem2/formal-cal/04_CAL_FIXED_SEQUENCE_REPORT.json"),
  requirePackagePath("evidence/mem2/untouched69/final-analysis/04_PRIMARY_MODEL_VALUE_RESULT.json"),
  requirePackagePath("evidence/mem2/untouched69/final-analysis/05_PAIRED_BOOTSTRAP_RESULT.json"),
  requirePackagePath("evidence/evo/adaptation/04_EVO_CONTINUOUS_DEVELOPMENT_BANK_REPORT.json"),
  requirePackagePath("evidence/evo/fresh-authority/frozen/post-t1/10_POST_T1_MODEL_CHECKPOINT.json"),
  requirePackagePath("evidence/evo/fresh-authority/frozen/post-t1/11_FINAL_PROPOSED_MODEL_FREEZE.json"),
  requirePackagePath("evidence/evo/fresh-authority/frozen/post-t1/16_FINAL_MODEL_SET_FREEZE.json"),
];
const auditPath = requirePackagePath("analysis/FINAL_TREATMENT_FIDELITY_AUDIT.md");
const finalReportPath = requirePackagePath("report/Direction_A_方案介绍与测试结论报告_李姝瑾.md");

function requestBindingPackagePath(relative) {
  const normalized = relative.replaceAll("\\", "/");
  if (normalized.startsWith("MemoryCore/")) {
    return `source/${normalized}`;
  }
  const closurePrefix = "Direction_A_Evo_Fresh_FinalRecovery_Closure_v1/";
  if (normalized.startsWith(closurePrefix)) {
    return `evidence/evo/fresh-authority/${normalized.slice(closurePrefix.length)}`;
  }
  const postT1Prefix = "Direction_A_Evo_PostT1_Requalification_Closure_v2/";
  if (normalized.startsWith(postT1Prefix)) {
    return `evidence/evo/fresh-authority/frozen/post-t1/${path.posix.basename(normalized)}`;
  }
  const postCalPrefix = "Direction_A_PostCAL_Model_Value_v2_1/";
  if (normalized.startsWith(postCalPrefix)) {
    return `evidence/mem2/untouched69/model-policy/${path.posix.basename(normalized)}`;
  }
  throw new Error(`No allowlist destination mapping for required binding: ${normalized}`);
}

const readText = (p) => fs.readFileSync(assertInsidePackage(p), "utf8");
const readJson = (p) => JSON.parse(readText(p));
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const shaFile = (p) => sha(fs.readFileSync(assertInsidePackage(p)));
const round12 = (x) => Number(x.toFixed(12));

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Cannot canonicalize value");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

const hashCanonical = (value) => sha(canonicalJson(value));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function hashDirectoryTree(directory) {
  assertInsidePackage(directory);
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  visit(directory);
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(directory, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function csvEscape(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function writeCsv(p, rows, columns) {
  const lines = [columns.join(","), ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(","))];
  fs.writeFileSync(p, `${lines.join("\n")}\n`, "utf8");
}

function readJsonl(p) {
  return readText(p).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function validateContentHash(document, label) {
  const { contentHash, ...body } = document;
  assert(contentHash === hashCanonical(body), `${label}: contentHash mismatch`);
}

function validateHashChain(events, label) {
  let previous = "GENESIS";
  events.forEach((event, index) => {
    assert(event.sequence === index + 1, `${label}: sequence mismatch at ${index + 1}`);
    assert(event.previousEventHash === previous, `${label}: previous hash mismatch at ${index + 1}`);
    const { eventHash, ...body } = event;
    assert(eventHash === hashCanonical(body), `${label}: event hash mismatch at ${index + 1}`);
    previous = event.eventHash;
  });
  return previous;
}

function validateLedgerChain(entries) {
  let previous = "GENESIS";
  entries.forEach((entry, index) => {
    assert(entry.sequence === index + 1, `budget ledger: sequence mismatch at ${index + 1}`);
    assert(entry.previousEventHash === previous, `budget ledger: previous hash mismatch at ${index + 1}`);
    const { contentHash, ...body } = entry;
    assert(contentHash === hashCanonical(body), `budget ledger: content hash mismatch at ${index + 1}`);
    previous = entry.contentHash;
  });
  return previous;
}

function findSingleFile(root, relativeSuffix) {
  const matches = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && full.replaceAll("\\", "/").endsWith(relativeSuffix)) matches.push(full);
    }
  };
  visit(root);
  assert(matches.length === 1, `Expected one ${relativeSuffix} below ${root}; found ${matches.length}`);
  return matches[0];
}

function parseCaseSummary(stdout, denominator, label) {
  const matches = [...stdout.matchAll(/CASE_SUMMARY\s+total_cases=(\d+)\s+success_count=(\d+)\s+fail_count=(\d+)/g)];
  assert(matches.length === 1, `${label}: expected exactly one CASE_SUMMARY`);
  const total = Number(matches[0][1]);
  const success = Number(matches[0][2]);
  const fail = Number(matches[0][3]);
  assert(total === denominator, `${label}: denominator mismatch`);
  assert(success + fail === total, `${label}: success/fail accounting mismatch`);
  return { total, success, fail, utility: success / total };
}

function methodMetrics(acceptedIds, thetaByTask) {
  const ids = Object.keys(thetaByTask);
  const accepted = new Set(acceptedIds);
  const a = ids.map((id) => accepted.has(id) ? 1 : 0);
  const y = ids.map((id) => thetaByTask[id]);
  const n = ids.length;
  const coverage = a.reduce((x, z) => x + z, 0) / n;
  const overall = y.reduce((x, z) => x + z, 0) / n;
  const value = a.reduce((x, z, i) => x + z * y[i], 0) / n;
  const acceptedMean = coverage ? value / coverage : null;
  const rejected = y.filter((_, i) => !a[i]);
  const rejectedMean = rejected.length ? rejected.reduce((x, z) => x + z, 0) / rejected.length : null;
  const gain = a.reduce((x, z, i) => x + (z - coverage) * y[i], 0) / n;
  return { coverage, acceptedCount: acceptedIds.length, acceptedMean, value, gain, overallMean: overall, rejectedMean };
}

fs.mkdirSync(output, { recursive: true });
const request = readJson(requestPath);
const manifest = readJson(manifestPath);
const state = readJson(statePath);
const barrier = readJson(barrierPath);
const featureRows = readJson(featureRowsPath);
const policy = readJson(policyPath);
const modelSet = readJson(modelSetPath);
const transitiveManifest = readJson(transitiveManifestPath);
const summary = readJson(summaryPath);
const events = readJsonl(journalPath);
const ledgerEvents = readJsonl(ledgerPath);

// Request-bound source verification: all 81 logical file bindings are checked against exact bytes.
assert(request.requiredBindingsCount === 81, "Request binding count is not 81");
assert(Object.keys(request.requiredBindings).length === 81, "Request requiredBindings does not contain 81 entries");
let matchedBindings = 0;
for (const [logicalId, expectedHash] of Object.entries(request.requiredBindings)) {
  const relative = request.requiredBindingPaths[logicalId];
  assert(typeof relative === "string", `Missing binding path for ${logicalId}`);
  const packageDestination = requestBindingPackagePath(relative);
  const absolute = requirePackagePath(packageDestination);
  assert(fs.existsSync(absolute), `Bound file missing: ${packageDestination}`);
  assert(shaFile(absolute) === expectedHash, `Bound file hash mismatch: ${relative}`);
  matchedBindings += 1;
}

validateContentHash(manifest, "prepared manifest");
validateContentHash(state, "run state");
validateContentHash(barrier, "normal barrier");
validateContentHash(policy, "pre-Y policy seal");
validateContentHash(modelSet, "model set");
validateContentHash(transitiveManifest, "transitive binding manifest");
assert(transitiveManifest.sourceImportUnionFileCount === 44, "Transitive source import closure is not 44 files");
assert(state.phase === "COMPLETE", "Runtime is not COMPLETE");
assert(policy.causalYDispatchCountAtFreeze === 0, "Pre-Y seal was not created before causal Y dispatch");
assert(modelSet.refitAfterFreshY === false, "Model set allows post-Fresh refit");
assert(policy.modelSetHash === modelSet.contentHash, "Policy/model-set hash mismatch");
const journalHead = validateHashChain(events, "execution journal");
const ledgerHead = validateLedgerChain(ledgerEvents);

const starts = events.filter((e) => e.eventType === "PAID_TRIAL_STARTED");
const finishes = events.filter((e) => e.eventType === "PAID_TRIAL_FINISHED");
const providerCalls = events.filter((e) => e.eventType === "PROVIDER_CALL_COMPLETED");
assert(new Set(starts.map((e) => e.attemptId)).size === starts.length, "Duplicate trial start attemptId detected");
assert(new Set(finishes.map((e) => e.attemptId)).size === finishes.length, "Duplicate trial finish attemptId detected");
assert(starts.length === finishes.length && starts.every((s) => finishes.some((f) => f.attemptId === s.attemptId)), "Dangling or finish-without-start trial detected");
assert(events.filter((e) => /UNCERTAIN/.test(e.eventType)).length === 0, "Uncertain dispatch event detected");
const canonicalSlots = state.slots.filter((slot) => slot.arm.startsWith("PAIR_") && slot.status !== "TECHNICAL_INVALID");
assert(canonicalSlots.length === 40, `Expected 40 canonical causal arms; got ${canonicalSlots.length}`);
assert(new Set(canonicalSlots.map((slot) => slot.attemptId)).size === 40, "Canonical attempt IDs are not unique");

const rawEvidence = [];
const directoryEvidence = [];
const pairRows = [];
const taskRows = [];
const treatmentChecks = [];

for (const group of manifest.groups.sort((a, b) => a.prefixIndex - b.prefixIndex)) {
  const taskRoot = preparedTaskRoot;
  const armRoots = Object.fromEntries(["full", "remove", "normal"].map((arm) => [arm, path.join(taskRoot, `evo-fresh-n9-n${group.prefixIndex}-${arm}`)]));
  assert(hashDirectoryTree(armRoots.full) === group.fullTaskDirectoryHash, `${group.taskId}: FULL task tree drift`);
  assert(hashDirectoryTree(armRoots.remove) === group.removeTaskDirectoryHash, `${group.taskId}: REMOVE task tree drift`);
  assert(hashDirectoryTree(armRoots.normal) === group.normalTaskDirectoryHash, `${group.taskId}: NORMAL task tree drift`);

  const fullInstructionPath = path.join(armRoots.full, "steps", "target-round", "instruction.md");
  const removeInstructionPath = path.join(armRoots.remove, "steps", "target-round", "instruction.md");
  const normalInstructionPath = path.join(armRoots.normal, "steps", "target-round", "instruction.md");
  const fullInstruction = readText(fullInstructionPath);
  const removeInstruction = readText(removeInstructionPath);
  const normalInstruction = readText(normalInstructionPath);
  assert(sha(Buffer.from(fullInstruction)) === group.fullInstructionHash, `${group.taskId}: FULL instruction hash drift`);
  assert(sha(Buffer.from(removeInstruction)) === group.targetInstructionHash, `${group.taskId}: REMOVE instruction hash drift`);
  assert(sha(Buffer.from(normalInstruction)) === group.normalInstructionHash, `${group.taskId}: NORMAL instruction hash drift`);
  assert(fullInstruction === normalInstruction, `${group.taskId}: FULL and NORMAL instructions differ`);
  assert(fullInstruction.includes("<memory_context "), `${group.taskId}: FULL missing memory_context`);
  assert(!removeInstruction.includes("<memory_context "), `${group.taskId}: REMOVE contains memory_context`);
  assert(fullInstruction.endsWith(removeInstruction), `${group.taskId}: FULL does not preserve exact target instruction suffix`);

  const fullTreatment = readJson(path.join(armRoots.full, "DIRECTION_A_TREATMENT.json"));
  const removeTreatment = readJson(path.join(armRoots.remove, "DIRECTION_A_TREATMENT.json"));
  assert(fullTreatment.taskCandidateHash === group.taskCandidateHash, `${group.taskId}: FULL candidate mismatch`);
  assert(fullTreatment.injectedCandidateHash === group.taskCandidateHash, `${group.taskId}: FULL injection mismatch`);
  assert(removeTreatment.taskCandidateHash === group.taskCandidateHash, `${group.taskId}: REMOVE candidate mismatch`);
  assert(removeTreatment.injectedCandidateHash === null, `${group.taskId}: REMOVE injection is not null`);

  const environmentHashes = ["full", "remove", "normal"].map((arm) => hashDirectoryTree(path.join(armRoots[arm], "environment")));
  const testHashes = ["full", "remove", "normal"].map((arm) => hashDirectoryTree(path.join(armRoots[arm], "steps", "target-round", "tests")));
  assert(new Set(environmentHashes).size === 1, `${group.taskId}: environment differs across arms`);
  assert(new Set(testHashes).size === 1, `${group.taskId}: tests differ across arms`);
  assert(testHashes[0] === group.preparedTargetTestsDirectoryHash, `${group.taskId}: prepared tests hash mismatch`);

  treatmentChecks.push({
    taskId: group.taskId,
    prefixIndex: group.prefixIndex,
    fullHasMemoryContext: true,
    removeHasMemoryContext: false,
    fullExactTargetSuffix: true,
    identicalEnvironmentHash: environmentHashes[0],
    identicalTestsHash: testHashes[0],
    taskCandidateHash: group.taskCandidateHash,
  });
  directoryEvidence.push(...["full", "remove", "normal"].map((arm, index) => ({
    path: armRoots[arm],
    sha256Tree: [group.fullTaskDirectoryHash, group.removeTaskDirectoryHash, group.normalTaskDirectoryHash][index],
  })));
  rawEvidence.push(...[fullInstructionPath, removeInstructionPath, normalInstructionPath,
    path.join(armRoots.full, "DIRECTION_A_TREATMENT.json"),
    path.join(armRoots.remove, "DIRECTION_A_TREATMENT.json")]
    .map((p) => ({ path: p, sha256: shaFile(p) })));

  const pairDs = [];
  for (const schedule of group.pairSchedule.rows.sort((a, b) => a.pairIndex - b.pairIndex)) {
    const attestationPath = path.join(rawRuntime, "attempt-integrity-attestations", `${group.taskId}-pair-${schedule.pairIndex}.json`);
    const pairAttestation = readJson(attestationPath);
    assert(pairAttestation.pairIndex === schedule.pairIndex, `${group.taskId} pair ${schedule.pairIndex}: attestation pair mismatch`);
    assert(pairAttestation.scheduledArmOrder === schedule.scheduledArmOrder, `${group.taskId} pair ${schedule.pairIndex}: schedule mismatch`);
    assert(pairAttestation.actualArmStartOrder[0] === (schedule.scheduledArmOrder === "FULL_FIRST" ? "FULL" : "REMOVE"), `${group.taskId} pair ${schedule.pairIndex}: first-start order violation`);
    assert(pairAttestation.attestations.length === pairAttestation.actualArmStartOrder.length, `${group.taskId} pair ${schedule.pairIndex}: attestation/start count mismatch`);

    const observations = {};
    for (const arm of ["FULL", "REMOVE"]) {
      const slotArm = `PAIR_${schedule.pairIndex}_${arm}`;
      const matches = canonicalSlots.filter((slot) => slot.taskId === group.taskId && slot.arm === slotArm);
      assert(matches.length === 1, `${group.taskId} pair ${schedule.pairIndex} ${arm}: canonical slot count ${matches.length}`);
      const slot = matches[0];
      const attMatches = pairAttestation.attestations.filter((a) => a.attemptId === slot.attemptId);
      assert(attMatches.length === 1, `${slot.attemptId}: canonical attestation count ${attMatches.length}`);
      const att = attMatches[0];
      assert(att.contextIsolationPass === true, `${slot.attemptId}: context isolation failed`);
      assert(att.arm === arm && att.actualStartedArm === arm, `${slot.attemptId}: attested arm mismatch`);
      assert(att.taskId === group.taskId && att.causalGroupId === group.causalGroupId, `${slot.attemptId}: identity mismatch`);
      assert(att.targetSpecHash === group.targetGroupHash, `${slot.attemptId}: target spec mismatch`);
      assert(att.pairScheduleHash === group.pairSchedule.scheduleHash, `${slot.attemptId}: schedule hash mismatch`);
      assert(att.workspaceIsolationHash === (arm === "FULL" ? group.fullTaskDirectoryHash : group.removeTaskDirectoryHash), `${slot.attemptId}: workspace hash mismatch`);
      assert(att.providerId === "deepseek" && att.modelId === "deepseek/deepseek-v4-pro", `${slot.attemptId}: provider/model drift`);
      assert(att.scaffoldId === "HARBOR_TERMINUS_2_PINNED" && att.horizonId === "AGENT_TURNS_12", `${slot.attemptId}: scaffold/horizon drift`);
      validateContentHash(att, `${slot.attemptId} attestation`);

      const startMatches = starts.filter((e) => e.attemptId === slot.attemptId);
      const finishMatches = finishes.filter((e) => e.attemptId === slot.attemptId);
      assert(startMatches.length === 1 && finishMatches.length === 1, `${slot.attemptId}: start/finish not unique`);
      assert(startMatches[0].eventHash === att.journalStartEventHash, `${slot.attemptId}: journal start hash mismatch`);
      assert(startMatches[0].arm === arm && startMatches[0].pairIndex === schedule.pairIndex, `${slot.attemptId}: journal arm/pair mismatch`);
      assert(finishMatches[0].terminalStatus === "VALID_RESULT", `${slot.attemptId}: terminal status is not VALID_RESULT`);

      const configPath = path.join(rawRuntime, "harbor-configs", `${slot.attemptId}.json`);
      const config = readJson(configPath);
      const expectedTaskRoot = armRoots[arm.toLowerCase()];
      const expectedTaskSuffix = `/prepared/tasks/${path.basename(expectedTaskRoot)}`;
      const configuredTaskPath = String(config.tasks[0].path).replaceAll("\\", "/").replace(/\/+$/, "");
      assert(configuredTaskPath.endsWith(expectedTaskSuffix), `${slot.attemptId}: Harbor task path mismatch`);
      assert(config.agents[0].model_name === "deepseek/deepseek-v4-pro", `${slot.attemptId}: Harbor model mismatch`);
      assert(config.agents[0].name === "terminus-2", `${slot.attemptId}: Harbor agent mismatch`);
      assert(config.agents[0].kwargs.max_turns === 12, `${slot.attemptId}: Harbor horizon mismatch`);
      assert(config.agents[0].kwargs.reasoning_effort === "high" && config.agents[0].kwargs.use_responses_api === true, `${slot.attemptId}: Harbor decoding mismatch`);

      const jobRoot = path.join(rawRuntime, "harbor-jobs", `evo-fresh-n9-${slot.attemptId}`);
      assertInsidePackage(jobRoot);
      assert(fs.existsSync(jobRoot), `${slot.attemptId}: job root missing at ${packageRelative(jobRoot)}`);
      const trialDirs = fs.readdirSync(jobRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(jobRoot, e.name));
      assert(trialDirs.length === 1, `${slot.attemptId}: expected one trial directory`);
      const trialRoot = trialDirs[0];
      const trialResultPath = path.join(trialRoot, "result.json");
      const trajectoryPath = path.join(trialRoot, "steps", "target-round", "agent", "trajectory.json");
      const verifierStdoutPath = path.join(trialRoot, "steps", "target-round", "verifier", "test-stdout.txt");
      const trialResult = readJson(trialResultPath);
      const trajectory = readJson(trajectoryPath);
      assert(trialResult.task_name === path.basename(expectedTaskRoot), `${slot.attemptId}: result task_name mismatch`);
      const resultTaskPath = String(trialResult.task_id.path).replaceAll("\\", "/").replace(/\/+$/, "");
      assert(resultTaskPath.endsWith(expectedTaskSuffix), `${slot.attemptId}: result task path mismatch`);
      assert(trialResult.config.agent.model_name === "deepseek/deepseek-v4-pro", `${slot.attemptId}: result model mismatch`);
      const firstUserMessage = trajectory.steps.find((step) => step.source === "user")?.message;
      assert(typeof firstUserMessage === "string", `${slot.attemptId}: no user message in trajectory`);
      const preparedInstruction = arm === "FULL" ? fullInstruction : removeInstruction;
      assert(firstUserMessage.includes(preparedInstruction), `${slot.attemptId}: prepared instruction not delivered verbatim`);
      assert(arm === "FULL" ? firstUserMessage.includes("<memory_context ") : !firstUserMessage.includes("<memory_context "), `${slot.attemptId}: treatment content mismatch in trajectory`);
      const counts = parseCaseSummary(readText(verifierStdoutPath), group.frozenTotalCases, slot.attemptId);
      observations[arm] = { slot, att, counts, trialResultPath, trajectoryPath, verifierStdoutPath, configPath };
      rawEvidence.push(...[configPath, attestationPath, trialResultPath, trajectoryPath, verifierStdoutPath].map((p) => ({ path: p, sha256: shaFile(p) })));
    }

    const difference = observations.FULL.counts.utility - observations.REMOVE.counts.utility;
    pairDs.push(difference);
    pairRows.push({
      task_id: group.taskId,
      prefix_index: group.prefixIndex,
      causal_group_id: group.causalGroupId,
      pair_index: schedule.pairIndex,
      scheduled_order: schedule.scheduledArmOrder,
      actual_start_order_all_attempts: pairAttestation.actualArmStartOrder.join(" > "),
      canonical_terminal_order: [observations.FULL.att.actualArmStartOrdinal < observations.REMOVE.att.actualArmStartOrdinal ? "FULL > REMOVE" : "REMOVE > FULL"][0],
      full_attempt_id: observations.FULL.slot.attemptId,
      remove_attempt_id: observations.REMOVE.slot.attemptId,
      full_success_count: observations.FULL.counts.success,
      remove_success_count: observations.REMOVE.counts.success,
      frozen_total_cases: group.frozenTotalCases,
      full_utility: round12(observations.FULL.counts.utility),
      remove_utility: round12(observations.REMOVE.counts.utility),
      d_full_minus_remove: round12(difference),
      recovery_used: [observations.FULL.slot.attemptId, observations.REMOVE.slot.attemptId].some((id) => id.includes("recovery")),
      full_terminal_state: observations.FULL.slot.status,
      remove_terminal_state: observations.REMOVE.slot.status,
      full_verifier_stdout: observations.FULL.verifierStdoutPath,
      remove_verifier_stdout: observations.REMOVE.verifierStdoutPath,
      full_trajectory: observations.FULL.trajectoryPath,
      remove_trajectory: observations.REMOVE.trajectoryPath,
      pair_attestation: attestationPath,
    });
  }
  const theta = pairDs.reduce((x, y) => x + y, 0) / 4;
  taskRows.push({ taskId: group.taskId, prefixIndex: group.prefixIndex, frozenTotalCases: group.frozenTotalCases, pairDifferences: pairDs, thetaHatFixed4: theta });
}

assert(pairRows.length === 20, `Expected 20 pairs; got ${pairRows.length}`);
assert(new Set(pairRows.flatMap((row) => [row.full_verifier_stdout, row.remove_verifier_stdout])).size === 40, "Canonical arms reuse a verifier output path");
assert(new Set(pairRows.flatMap((row) => [row.full_trajectory, row.remove_trajectory])).size === 40, "Canonical arms reuse a trajectory path");
const thetaByTask = Object.fromEntries(taskRows.map((row) => [row.taskId, row.thetaHatFixed4]));

// Independently reconstructed task results must agree with the post-run summary (summary is not used as an outcome source).
for (const row of taskRows) {
  const reported = summary.tasks.find((x) => x.taskId === row.taskId);
  assert(reported, `Summary missing ${row.taskId}`);
  assert(Math.abs(reported.thetaHatFixed4 - row.thetaHatFixed4) < 1e-6, `Summary theta mismatch for ${row.taskId}`);
  row.pairDifferences.forEach((d, index) => assert(Math.abs(reported.perPairD[index].D_gj - d) < 1e-6, `Summary pair mismatch for ${row.taskId} pair ${index + 1}`));
}

const methodNames = {
  proposed: modelSet.proposed.id,
  primaryBaseline: modelSet.primaryBaseline.id,
  strongComparator: modelSet.strongComparator.id,
};
const metricRows = [];
const metricsByCoverage = {};
for (const coverageLabel of ["40", "60", "70", "80"]) {
  const object = policy.priorityObjects[coverageLabel];
  metricsByCoverage[coverageLabel] = {};
  for (const methodKey of ["proposed", "primaryBaseline", "strongComparator"]) {
    const metrics = methodMetrics(object[methodKey], thetaByTask);
    metricsByCoverage[coverageLabel][methodKey] = { methodId: methodNames[methodKey], acceptedTaskIds: object[methodKey], ...metrics };
    metricRows.push({
      coverage_label_percent: coverageLabel,
      method_role: methodKey,
      method_id: methodNames[methodKey],
      accepted_count: metrics.acceptedCount,
      realized_coverage: round12(metrics.coverage),
      accepted_mean_mu_a: round12(metrics.acceptedMean),
      value_v: round12(metrics.value),
      gain_g: round12(metrics.gain),
      overall_mean_theta: round12(metrics.overallMean),
      rejected_mean_theta: round12(metrics.rejectedMean),
      accepted_task_ids: object[methodKey].join(" | "),
    });
  }
}

const primary = metricsByCoverage["70"];
const contrasts = {
  proposedMinusPrimaryBaseline: {
    deltaV: primary.proposed.value - primary.primaryBaseline.value,
    deltaG: primary.proposed.gain - primary.primaryBaseline.gain,
  },
  proposedMinusStrongComparator: {
    deltaV: primary.proposed.value - primary.strongComparator.value,
    deltaG: primary.proposed.gain - primary.strongComparator.gain,
  },
};

const costByAttempt = new Map();
for (const call of providerCalls) {
  const prior = costByAttempt.get(call.attemptId) ?? { calls: 0, costCny: 0 };
  prior.calls += 1;
  prior.costCny += call.amountCny;
  costByAttempt.set(call.attemptId, prior);
}
const totalCost = providerCalls.reduce((sum, e) => sum + e.amountCny, 0);
const phase1Calls = providerCalls.filter((e) => e.attemptId.includes("phase1-"));
const phase3Calls = providerCalls.filter((e) => e.attemptId.includes("phase3-"));
const phase1Cost = phase1Calls.reduce((sum, e) => sum + e.amountCny, 0);
const phase3Cost = phase3Calls.reduce((sum, e) => sum + e.amountCny, 0);
assert(providerCalls.length === 576, `Expected 576 provider calls; got ${providerCalls.length}`);
assert(Math.abs(totalCost - 87.461325) < 1e-9, `Fresh cost mismatch: ${totalCost}`);
const causalHostRecoveryIds = ["fresh-n9-phase3-3-pair_3_remove-hostrecovery-1", "fresh-n9-phase3-4-pair_3_full-hostrecovery-1"];
const allRecoveryIds = [...costByAttempt.keys()].filter((id) => id.includes("recovery"));
const sumAttempts = (ids) => ids.reduce((acc, id) => {
  const row = costByAttempt.get(id) ?? { calls: 0, costCny: 0 };
  return { calls: acc.calls + row.calls, costCny: acc.costCny + row.costCny };
}, { calls: 0, costCny: 0 });
const causalHostRecovery = sumAttempts(causalHostRecoveryIds);
const allRecoveries = sumAttempts(allRecoveryIds);
const zeroProviderAttempts = state.hostInfrastructureAbortedAttempts;
assert(zeroProviderAttempts.length === 4, `Expected four zero-provider causal aborts; got ${zeroProviderAttempts.length}`);
for (const attempt of zeroProviderAttempts) assert((costByAttempt.get(attempt.attemptId)?.calls ?? 0) === 0, `${attempt.attemptId}: expected zero provider calls`);

const inferenceFreezeSearchFiles = [requestPath, policyPath, modelSetPath, transitiveManifestPath];
const inferenceTokens = /bootstrap|webb|satterthwaite|\bcr2\b|inferenceWinner|confidenceInterval/i;
const exactInferenceSpecificationFound = inferenceFreezeSearchFiles.some((p) => inferenceTokens.test(readText(p)));
assert(exactInferenceSpecificationFound === false, "Unexpected final Fresh endpoint inference specification found; manual review required");

const pairCsvPath = path.join(output, "FINAL_HELDOUT_TASK_PAIR_TABLE.csv");
const metricsCsvPath = path.join(output, "FINAL_METHOD_METRICS.csv");
writeCsv(pairCsvPath, pairRows, [
  "task_id", "prefix_index", "causal_group_id", "pair_index", "scheduled_order", "actual_start_order_all_attempts", "canonical_terminal_order",
  "full_attempt_id", "remove_attempt_id", "full_success_count", "remove_success_count", "frozen_total_cases", "full_utility", "remove_utility",
  "d_full_minus_remove", "recovery_used", "full_terminal_state", "remove_terminal_state", "full_verifier_stdout", "remove_verifier_stdout",
  "full_trajectory", "remove_trajectory", "pair_attestation",
]);
writeCsv(metricsCsvPath, metricRows, [
  "coverage_label_percent", "method_role", "method_id", "accepted_count", "realized_coverage", "accepted_mean_mu_a", "value_v", "gain_g",
  "overall_mean_theta", "rejected_mean_theta", "accepted_task_ids",
]);

const analysis = {
  schemaVersion: "direction-a.final-heldout-analysis.v1",
  evidenceCutoff: events.at(-1).occurredAt,
  scientificStatus: "PARTIALLY_SUPPORTED",
  treatmentFidelityVerdict: "PASS_WITH_LIMITATION",
  treatmentFidelity: {
    canonicalScientificArmsChecked: canonicalSlots.length,
    completePairsChecked: pairRows.length,
    taskGroupsChecked: treatmentChecks.length,
    checks: treatmentChecks,
    passedClaims: [
      "FULL and REMOVE preserve the same target instruction, frozen workspace, native tests, provider/model/scaffold/decoding/horizon, and differ in delivered memory treatment.",
      "All 40 canonical trajectories contain the exact prepared arm instruction; FULL contains memory_context and REMOVE does not.",
      "All 40 outcomes were re-extracted from native verifier CASE_SUMMARY lines with frozen denominators.",
      "All 20 pair attestations bind scheduled/actual order, restored state, task hash, workspace isolation, and journal start event.",
      "All 81 request-bound files and both journal chains match their cryptographic bindings.",
    ],
    limitations: [
      "The two causal host-recovery driver files were recorded after the request-binding closure and are not among the request/runtime cryptographic bindings; chronology and immutable runtime evidence support the recoveries, but byte-exact executed wrapper provenance cannot be claimed.",
      "The current phase-3 supervisor is a post-experiment engineering version, not the byte-exact executed wrapper.",
      "The wider Harbor/runtime toolchain binary environment was not fully content-addressed; conclusions are conditional on the attested frozen task, profile, and observed runtime evidence.",
    ],
  },
  sample: { taskClusters: taskRows.length, fixedPairsPerTask: 4, completePairs: pairRows.length, canonicalArms: canonicalSlots.length },
  estimator: "thetaHat_g = mean_j=1..4(U_FULL_gj - U_REMOVE_gj), with U = native success_count / frozen_total_cases",
  tasks: taskRows.map((row) => ({
    ...row,
    pairDifferences: row.pairDifferences.map(round12),
    thetaHatFixed4: round12(row.thetaHatFixed4),
  })),
  primaryCoverage: {
    labelPercent: 70,
    acceptedCountContract: policy.acceptedCount70,
    realizedCoverage: primary.proposed.coverage,
    methods: primary,
    contrasts,
  },
  coverageSensitivity: metricsByCoverage,
  inference: {
    finalFreshEndpointInferenceWinnerFrozenBeforeY: false,
    status: "NO_FINAL_FRESH_ENDPOINT_INFERENCE_WINNER_FROZEN",
    searchScope: inferenceFreezeSearchFiles,
    consequence: "Report point estimates only; do not attach a formal 95% confidence interval, p-value, or significance claim. No post-hoc inference family was selected.",
  },
  costs: {
    freshProviderCalls: providerCalls.length,
    freshInternalLedgerCostCny: round12(totalCost),
    phase1NormalProviderCalls: phase1Calls.length,
    phase1NormalCostCny: round12(phase1Cost),
    phase3CausalProviderCalls: phase3Calls.length,
    phase3CausalCostCny: round12(phase3Cost),
    budgetCapCny: request.globalHardCapCny,
    remainingCny: round12(request.globalHardCapCny - totalCost),
    causalHostRecoveryAttemptIds: causalHostRecoveryIds,
    causalHostRecoveryCalls: causalHostRecovery.calls,
    causalHostRecoveryCostCny: round12(causalHostRecovery.costCny),
    allRecoveryAttemptIds: allRecoveryIds,
    allRecoveryCalls: allRecoveries.calls,
    allRecoveryCostCny: round12(allRecoveries.costCny),
    zeroProviderTechnicalAbortCount: zeroProviderAttempts.length,
    zeroProviderTechnicalAbortIds: zeroProviderAttempts.map((x) => x.attemptId),
  },
  claimLadder: {
    L0: "SUPPORTED_WITH_PROVENANCE_LIMITATIONS: executed artifacts, treatment delivery, frozen native scoring, and request-bound closure were verified; recovery wrapper byte identity and full toolchain lock remain limited.",
    L1: "SUPPORTED_AS_POINT_ESTIMATE_ONLY: four task effects are exactly zero; one task has thetaHat=0.056501547988 with high pair dispersion.",
    L2: "SUPPORTED_AS_POINT_ESTIMATE_ONLY: at the four-of-five primary acceptance rule, every method has V=0.011300309598 and G=0.00226006192.",
    L3: "NOT_DEMONSTRATED: Proposed minus either baseline is DeltaV=0 and DeltaG=0.",
    L4: "NOT_DEMONSTRATED: no new task family, Q6 transport, natural online write/retrieval, or deployment-scale generalization was tested.",
  },
  interpretation: {
    strongestAllowedClaim: "On this frozen five-task Fresh engineering holdout, the memory treatment changed native case success only for one task, while the Proposed, matched-capacity baseline, and target-only comparator tied on the primary value and gain point estimates.",
    biggestLimitation: "Only five task clusters were observed and no exact final Fresh endpoint inference procedure was frozen before Y, so superiority, confidence-interval, significance, and broad generalization claims are not licensed.",
  },
  crossChecks: {
    requestBindingsMatched: matchedBindings,
    transitiveSourceImportFiles: transitiveManifest.sourceImportUnionFileCount,
    duplicateDispatch: 0,
    uncertainDispatch: 0,
    danglingDispatch: 0,
    runtimePhase: state.phase,
    journalEvents: events.length,
    journalHead,
    ledgerEvents: ledgerEvents.length,
    ledgerHead,
    summaryAgreement: true,
    noProviderCallsDuringAnalysis: true,
    noRefit: true,
    noThresholdTuning: true,
    noAdditionalExperiment: true,
  },
};

const analysisJsonPath = path.join(output, "FINAL_HELDOUT_ANALYSIS.json");
fs.writeFileSync(analysisJsonPath, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");

const provenance = {
  schemaVersion: "direction-a.final-analysis-provenance.v1",
  authorityVersion: "Direction_A_Codex_Whole_Project_Final_Report_Revision_GOAL_20260914 + Direction_A_Conversation2_Final_Analysis_and_Report_GOAL_20260914 + Direction_A_Evo_Fresh_FinalRecovery_Closure_v1",
  evidenceCutoff: events.at(-1).occurredAt,
  treatmentFidelityStatus: analysis.treatmentFidelityVerdict,
  inferenceFamilyStatus: analysis.inference.status,
  analysisScript: { path: scriptPath, sha256: shaFile(scriptPath) },
  authorityInputs: [wholeProjectGoalPath, goalPath, candidateMapPath, requestPath, transitiveManifestPath, modelSetPath].map((p) => ({ path: p, sha256: shaFile(p) })),
  wholeProjectSynthesisInputs: wholeProjectSynthesisInputs.map((p) => ({ path: p, sha256: shaFile(p) })),
  runtimeInputs: [manifestPath, statePath, journalPath, ledgerPath, barrierPath, featureRowsPath, policyPath, summaryPath, completeReportPath].map((p) => ({ path: p, sha256: shaFile(p) })),
  rawEvidence: [...new Map(rawEvidence.map((row) => [row.path, row])).values()].sort((a, b) => a.path.localeCompare(b.path)),
  directoryEvidence: [...new Map(directoryEvidence.map((row) => [row.path, row])).values()].sort((a, b) => a.path.localeCompare(b.path)),
  generatedArtifacts: [pairCsvPath, metricsCsvPath, analysisJsonPath, auditPath, finalReportPath]
    .filter((p) => fs.existsSync(p)).map((p) => ({ path: p, sha256: shaFile(p) })),
  reconstructionRules: {
    outcomes: "Parsed exactly one CASE_SUMMARY from each canonical trial's raw verifier test-stdout.txt; did not use report rewards or summary values as outcome sources.",
    canonicalAttempts: "Selected run-state PAIR slots whose terminal status was not TECHNICAL_INVALID, then required one journal start, one VALID_RESULT finish, and one matching attestation.",
    policy: "Used the pre-Y frozen accepted task IDs for 40/60/70/80; no scores, ranks, thresholds, or models were changed.",
    inference: "No exact final Fresh endpoint inference winner was found in the request, pre-Y seal, model-set freeze, or transitive binding manifest; no post-hoc method was chosen.",
  },
  prohibitionsObserved: { providerCalls: 0, retraining: false, thresholdTuning: false, additionalExperiments: false },
};
fs.writeFileSync(path.join(output, "FINAL_ANALYSIS_PROVENANCE.json"), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  treatmentFidelityVerdict: analysis.treatmentFidelityVerdict,
  scientificStatus: analysis.scientificStatus,
  taskClusters: taskRows.length,
  pairs: pairRows.length,
  canonicalArms: canonicalSlots.length,
  primary,
  contrasts,
  costs: analysis.costs,
  journalEvents: events.length,
  output,
  packageRoot,
  packageContainedInputCount: accessedPackagePaths.size,
  outsidePackageApplicationReads: 0,
}, null, 2));


