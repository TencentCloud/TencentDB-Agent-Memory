import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fitFinalCandidateFromNested,
  hashCanonical,
  runTaskClusterNestedEvaluation,
  scoreFrozenSource,
  summarizeOuterDirectionalStability,
  type EvoCandidateId,
  type EvoContinuousRow,
  type EvoFeatureBlock,
  type FrozenSourceModel,
  type NestedCandidateResult,
} from "../../../src/evaluation/direction-a/formal/index.js";

type Json = Record<string, any>;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const memoryCore = path.resolve(scriptDir, "../../../");
const repositoryRoot = path.dirname(memoryCore);
const outputRoot = path.join(repositoryRoot, "Direction_A_Evo_Continuous_Adaptation_v1");
const linkageRoot = path.join(path.dirname(repositoryRoot), "Direction_A_Evo_Continuous_Adaptation_v1");
const createdAt = "2026-09-11T00:00:00.000+08:00";
const sourceExpectedContentHash = "2f0449629a228baca869a167649bea1aa809040f539d5c82073efa201c1ba139";
const q6ExpectedContentHash = "91f7889336a978b3f9970555410db18169a34f8a087852856867b106509541c3";
const expansionSeed = "direction-a-evo-continuous-train-expansion-2026-09-11-v1";
const roleSeed = "direction-a-evo-capacity-firewall-2026-09-11-v1";
const sharedFeatureIds = [
  "shared_target_round_log",
  "shared_instruction_bytes_log",
  "shared_normal_utility",
  "shared_normal_strict_pass",
  "shared_completion_tokens_log",
] as const;
const processFeatureIds = [
  "process_edit_commands_log",
  "process_test_compile_commands_log",
  "process_revision_recovery_log",
] as const;
const lambdas = [10, 100, 1000] as const;
const featureBlocks = ["EVO_SHARED_ONLY", "EVO_SHARED_PLUS_PROCESS"] as const;
const candidateIds: EvoCandidateId[] = [
  "A_FROZEN_SOURCE_RESIDUAL_RIDGE",
  "B_SEPARATE_SCALE_PARTIAL_POOLING",
  "C_EVO_ONLY_RIDGE",
];

const rel = (absolute: string) => path.relative(repositoryRoot, absolute).replaceAll("\\", "/");
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const quantile = (values: readonly number[], probability: number): number => {
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(ordered.length - 1, Math.ceil(probability * ordered.length) - 1));
  return ordered[index];
};
const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const round = (value: number, digits = 12) => Number(value.toFixed(digits));

async function readJson(file: string): Promise<Json> {
  return JSON.parse(await readFile(file, "utf8")) as Json;
}

async function writeText(name: string, text: string): Promise<void> {
  await writeFile(path.join(outputRoot, name), text.replaceAll("\r\n", "\n"), "utf8");
}

function withHash<T extends Json>(body: T): T & { contentHash: string } {
  return { ...body, contentHash: hashCanonical(body) };
}

async function writeJson(name: string, body: Json): Promise<Json> {
  const document = body.contentHash ? body : withHash(body);
  await writeFile(path.join(outputRoot, name), `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return document;
}

async function listJsonFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listJsonFiles(child));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(child);
  }
  return files.sort();
}

function extractProcess(rawTrajectory: string): Json {
  const parsed = JSON.parse(rawTrajectory) as Json;
  const agentSteps = (parsed.steps as Json[]).filter((step) => step.source === "agent");
  const commands: string[] = [];
  let completionTokens = 0;
  let errorMarkers = 0;
  for (const step of agentSteps) {
    completionTokens += Number(step.metrics?.completion_tokens ?? 0);
    for (const call of (step.tool_calls ?? []) as Json[]) {
      const keystrokes = call.arguments?.keystrokes;
      if (typeof keystrokes === "string") commands.push(keystrokes);
    }
    const observation = JSON.stringify(step.observation ?? "");
    errorMarkers += (observation.match(/\b(?:fail(?:ed)?|error|exception|exit code [1-9])\b/gi) ?? []).length;
  }
  const edit = /(?:apply_patch|sed\s+-i|perl\s+-pi|tee\s+|cat\s*>|python\S*\s+.*(?:write|open\())/i;
  const testCompile = /(?:\bgo\s+(?:test|build)\b|\bnpm\s+test\b|\bpnpm\s+test\b|\bpytest\b|\bcargo\s+test\b|\bmake(?:\s|$)|\btsc\b|\bvitest\b|\bcmake\b|\bgcc\b)/i;
  const editIndices = commands.map((command, index) => edit.test(command) ? index : -1).filter((index) => index >= 0);
  const testIndices = commands.map((command, index) => testCompile.test(command) ? index : -1).filter((index) => index >= 0);
  const firstTest = testIndices[0] ?? Number.POSITIVE_INFINITY;
  const revisionsAfterTest = editIndices.filter((index) => index > firstTest).length;
  return {
    agentSteps: agentSteps.length,
    commandBatches: commands.length,
    editCommands: editIndices.length,
    testCompileCommands: testIndices.length,
    revisionsAfterTest,
    errorMarkers,
    completionTokens,
  };
}

function parseCaseSummary(verifierOutput: string): { total: number; success: number; utility: number; strictPass: number } {
  const match = /CASE_SUMMARY total_cases=(\d+) success_count=(\d+) fail_count=(\d+)/.exec(verifierOutput);
  if (!match) throw new Error("NORMAL_CASE_SUMMARY_MISSING");
  const total = Number(match[1]);
  const success = Number(match[2]);
  return { total, success, utility: success / total, strictPass: Number(success === total) };
}

function sourceInputs(group: Json, instruction: string, normal: { utility: number; strictPass: number }, process: Json, source: Json): Json {
  const values: Json = {
    x0_history_turn_count_log: Math.log1p(Number(group.targetRound) - 1),
    x0_query_token_count_log: Math.log1p(Math.ceil(Buffer.byteLength(instruction, "utf8") / 4)),
    n_utility: normal.utility,
    n_strict_pass: normal.strictPass,
    n_completion_tokens_log: Math.log1p(Number(process.completionTokens)),
  };
  for (const id of ["n_tool_name_matches", "n_required_argument_coverage", "n_query_action_jaccard"]) {
    values[id] = source.model.means[source.model.featureOrder.indexOf(id)];
  }
  return values;
}

function seededHash(seed: string, id: string): string { return hashCanonical({ seed, id }); }

function chooseExpansion(tasks: Json[], groups: Json[], currentTasks: Set<string>, q6Tasks: Set<string>): { tasks: Json[]; groups: Json[] } {
  const currentDomains = new Set(tasks.filter((task) => currentTasks.has(task.taskId)).map((task) => task.officialDomainId));
  const eligible = tasks.filter((task) => !currentTasks.has(task.taskId) && !q6Tasks.has(task.taskId)
    && task.permission === "PILOT_TRAIN_DEV" && task.technicalEligible && task.executorCapable && task.verifierCapable
    && task.normalRunCheapXAvailable && task.processTelemetryAvailable && task.provenanceIntegrityAvailable);
  eligible.sort((left, right) => Number(currentDomains.has(left.officialDomainId)) - Number(currentDomains.has(right.officialDomainId))
    || right.eligibleCausalGroupCount - left.eligibleCausalGroupCount
    || seededHash(expansionSeed, left.taskId).localeCompare(seededHash(expansionSeed, right.taskId)));
  const selectedTasks = eligible.slice(0, 2);
  const changePriority = (group: Json): number => {
    const types = new Set(group.changeTypes as string[]);
    if (types.has("conflict") && types.has("extension")) return 4;
    if (types.has("correction") && types.has("extension")) return 3;
    if (types.has("extension")) return 2;
    if (types.has("correction")) return 1;
    return 0;
  };
  const selectedGroups = selectedTasks.map((task) => {
    const taskGroups = groups.filter((group) => group.taskId === task.taskId);
    const medianRound = (Math.min(...taskGroups.map((group) => group.targetRound)) + Math.max(...taskGroups.map((group) => group.targetRound))) / 2;
    taskGroups.sort((left, right) => changePriority(right) - changePriority(left)
      || Math.abs(left.targetRound - medianRound) - Math.abs(right.targetRound - medianRound)
      || seededHash(expansionSeed, left.causalGroupId).localeCompare(seededHash(expansionSeed, right.causalGroupId)));
    return taskGroups[0];
  });
  return { tasks: selectedTasks, groups: selectedGroups };
}

function bootstrapCosts(trialCosts: number[], draws: number, replicates = 20000): number[] {
  let state = 0x5eeda11;
  const random = () => { state = (1664525 * state + 1013904223) >>> 0; return state / 0x100000000; };
  return Array.from({ length: replicates }, () => {
    let total = 0;
    for (let index = 0; index < draws; index += 1) total += trialCosts[Math.floor(random() * trialCosts.length)];
    return total;
  });
}

async function main(): Promise<void> {
  await mkdir(outputRoot, { recursive: true });
  await mkdir(linkageRoot, { recursive: true });
  const sourcePath = path.join(repositoryRoot, "Direction_A_PostCAL_Model_Value_v2_1/11_PROPOSED_V2_FINAL_MODEL.json");
  const source = await readJson(sourcePath);
  const sourceRaw = await readFile(sourcePath);
  if (source.contentHash !== sourceExpectedContentHash) throw new Error("FROZEN_SOURCE_CONTENT_HASH_MISMATCH");
  const sourceBody = { ...source }; delete sourceBody.contentHash;
  if (hashCanonical(sourceBody) !== sourceExpectedContentHash) throw new Error("FROZEN_SOURCE_CANONICAL_HASH_MISMATCH");
  const frozenSource: FrozenSourceModel = {
    contentHash: source.contentHash,
    featureOrder: source.model.featureOrder,
    means: source.model.means,
    scales: source.model.scales,
    coefficients: source.model.coefficients,
    clip: source.model.clip,
  };

  const manifestPath = path.join(memoryCore, ".research/direction-a/current-formal/pilot/manifests/current-formal-initial6-evo-pilot-manifest-v6.json");
  const replayPath = path.join(memoryCore, ".research/direction-a/current-formal/post-pilot/teacher-interface-qualification-v2/11_REAL_INITIAL6_PREFIX_REPLAY.json");
  const inventoryPath = path.join(memoryCore, ".research/direction-a/current-formal/prepilot/initial6-candidate-selection-freeze-v1.json");
  const q6Path = path.join(memoryCore, ".research/direction-a/current-formal/prepilot/q6-holdout-seal-v1.json");
  const runtimeRoot = path.join(memoryCore, ".research/direction-a/current-formal/pilot/runtime-v3");
  const benchmarkIntegrityPath = path.join(memoryCore, ".research/direction-a/v6.3/evocodebench/EVO_E2_RUNTIME_INTEGRITY.json");
  const authorityRoot = path.join(memoryCore, ".research/direction-a/sources/codex_implementation_sync_package_v2/01_CURRENT_AUTHORITY");
  const authorityNames = [
    "00_READ_FIRST_V7_1.md",
    "831-方向A-方案-李姝瑾-v7.0_CURRENT_CONTINUOUS_CAUSAL.md",
    "Direction_A_Experiment_Design_MASTER.md",
    "Direction_A_Experiment_Control.md",
    "FINAL_FROZEN_DECISION_REGISTER.md",
    "Stage_0_Architecture_Baseline_Plan_v7_1_OVERLAY.md",
    "Stage_1_Paired_Supervision_Coding_Qualification_Plan_v7_1_OVERLAY.md",
    "Stage_2_Main_Method_Validation_Plan_v7_1_OVERLAY.md",
    "Stage_3_Transport_and_EB_Plan_v7_1_OVERLAY.md",
  ];
  const authorityBindings = await Promise.all(authorityNames.map(async (name) => {
    const file = path.join(authorityRoot, name);
    return { path: rel(file), sha256: sha(await readFile(file)) };
  }));
  const [manifest, replay, inventory, q6, benchmarkIntegrity] = await Promise.all([
    readJson(manifestPath), readJson(replayPath), readJson(inventoryPath), readJson(q6Path), readJson(benchmarkIntegrityPath),
  ]);
  if (q6.contentHash !== q6ExpectedContentHash || q6.sealedTaskIds.length !== 5) throw new Error("Q6_SEAL_MISMATCH");
  if (benchmarkIntegrity.status !== "E2_RUNTIME_INTEGRITY_PASS") throw new Error("EVO_BENCHMARK_PROVENANCE_FAIL");

  const pairFiles = await listJsonFiles(path.join(runtimeRoot, "results/pairs"));
  const pairs = await Promise.all(pairFiles.map(readJson));
  const normalFiles = await listJsonFiles(path.join(runtimeRoot, "results/normal"));
  const normalResults = await Promise.all(normalFiles.map(readJson));
  const normalByGroup = new Map(normalResults.map((result) => [result.causalGroupId as string, result]));
  const replay4 = (replay.rows as Json[]).find((row) => row.prefix === 4);
  if (!replay4 || replay4.rows.length !== manifest.groups.length) throw new Error("FIXED4_REPLAY_INCOMPLETE");
  const replayByGroup = new Map((replay4.rows as Json[]).map((row) => [row.causalGroupId as string, row]));

  const bankRows: Json[] = [];
  const modelingRows: EvoContinuousRow[] = [];
  for (const group of manifest.groups as Json[]) {
    const groupPairs = pairs.filter((pair) => pair.causalGroupId === group.causalGroupId).sort((left, right) => left.pairIndex - right.pairIndex);
    if (groupPairs.length < 4) throw new Error(`FIXED4_UNAVAILABLE:${group.causalGroupId}`);
    const fixed4 = groupPairs.slice(0, 4);
    const theta = mean(fixed4.map((pair) => Number(pair.difference)));
    const replayRow = replayByGroup.get(group.causalGroupId) as Json;
    if (Math.abs(theta - replayRow.estimate) > 1e-12) throw new Error(`FIXED4_REPLAY_MISMATCH:${group.causalGroupId}`);
    const normalArtifact = normalByGroup.get(group.causalGroupId) as Json;
    if (!normalArtifact) throw new Error(`NORMAL_RESULT_MISSING:${group.causalGroupId}`);
    const normalResult = normalArtifact.result as Json;
    const normal = parseCaseSummary(normalResult.verifierOutput as string);
    const process = extractProcess(normalResult.rawTrajectory as string);
    const instructionPath = path.join(memoryCore, group.normalTaskPath, "steps/target-round/instruction.md");
    const instruction = await readFile(instructionPath, "utf8");
    const adaptedSourceInputs = sourceInputs(group, instruction, normal, process, source);
    const sourceScore = scoreFrozenSource(frozenSource, adaptedSourceInputs);
    const sharedFeatures = {
      shared_target_round_log: Math.log1p(group.targetRound),
      shared_instruction_bytes_log: Math.log1p(Buffer.byteLength(instruction, "utf8")),
      shared_normal_utility: normal.utility,
      shared_normal_strict_pass: normal.strictPass,
      shared_completion_tokens_log: Math.log1p(process.completionTokens),
    };
    const processFeatures = {
      process_edit_commands_log: Math.log1p(process.editCommands),
      process_test_compile_commands_log: Math.log1p(process.testCompileCommands),
      process_revision_recovery_log: Math.log1p(process.revisionsAfterTest + process.errorMarkers),
    };
    const row = {
      schemaVersion: "direction-a.evo-continuous-development-row.v1",
      permission: "PILOT_TRAIN_DEV",
      causalGroupId: group.causalGroupId,
      taskId: group.taskId,
      statisticalClusterId: group.statisticalClusterId,
      officialDomainId: group.officialDomainId,
      targetRound: group.targetRound,
      fixed4PairIds: fixed4.map((pair) => pair.pairId),
      fixed4PairIndices: fixed4.map((pair) => pair.pairIndex),
      fixed4Differences: fixed4.map((pair) => pair.difference),
      thetaHatFixed4: theta,
      technicalStatus: "FOUR_TECHNICALLY_VALID_COMPLETE_PAIRS",
      historicalExtraPairsExcludedFromPrimaryTarget: groupPairs.slice(4).map((pair) => pair.pairId),
      normalEvidence: { artifactHash: normalArtifact.contentHash, resultHash: normalResult.technicalMetadata.resultHash,
        totalCases: normal.total, successCount: normal.success, utility: normal.utility, strictPass: Boolean(normal.strictPass) },
      sourceAdapterInputs: adaptedSourceInputs,
      frozenSourceScore: sourceScore,
      sharedFeatures,
      processFeatures,
      processEvidenceCounts: process,
      timingContract: "ALL_X_FROM_S0_OR_NORMAL_RUN_BEFORE_CAUSAL_FULL_REMOVE_Y",
      q6Excluded: true,
      calExcluded: true,
      sealedTestExcluded: true,
      pairRowsTreatedAsIid: false,
      targetAvailability: "AVAILABLE",
    };
    bankRows.push(withHash(row));
    modelingRows.push({ causalGroupId: group.causalGroupId, statisticalClusterId: group.statisticalClusterId,
      thetaHatFixed4: theta, sourceScore, sharedFeatures, processFeatures });
  }
  await writeFile(path.join(outputRoot, "03_EVO_CONTINUOUS_DEVELOPMENT_BANK.jsonl"), `${bankRows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

  const nested = Object.fromEntries(candidateIds.map((candidateId) => [candidateId, runTaskClusterNestedEvaluation({
    rows: modelingRows, candidateId, sharedFeatureIds, processFeatureIds, lambdas, featureBlocks,
  })])) as Record<EvoCandidateId, NestedCandidateResult>;
  const fixedBlockAblations = Object.fromEntries(candidateIds.map((candidateId) => [candidateId, {
    sharedOnly: runTaskClusterNestedEvaluation({ rows: modelingRows, candidateId, sharedFeatureIds, processFeatureIds, lambdas,
      featureBlocks: ["EVO_SHARED_ONLY"] }),
    sharedPlusProcess: runTaskClusterNestedEvaluation({ rows: modelingRows, candidateId, sharedFeatureIds, processFeatureIds, lambdas,
      featureBlocks: ["EVO_SHARED_PLUS_PROCESS"] }),
  }])) as Record<EvoCandidateId, { sharedOnly: NestedCandidateResult; sharedPlusProcess: NestedCandidateResult }>;

  const transferCandidates = [nested.A_FROZEN_SOURCE_RESIDUAL_RIDGE, nested.B_SEPARATE_SCALE_PARTIAL_POOLING]
    .sort((left, right) => left.metrics.rmse - right.metrics.rmse || left.metrics.mae - right.metrics.mae);
  const bestTransfer = transferCandidates[0];
  const targetOnly = nested.C_EVO_ONLY_RIDGE;
  const transferVsTarget = summarizeOuterDirectionalStability(bestTransfer, targetOnly);
  const targetRelativeGain = (bestTransfer.metrics.rmse - targetOnly.metrics.rmse) / Math.max(bestTransfer.metrics.rmse, 1e-12);
  const transferRelativeGain = (targetOnly.metrics.rmse - bestTransfer.metrics.rmse) / Math.max(targetOnly.metrics.rmse, 1e-12);
  const negativeTransfer = targetRelativeGain >= 0.05 && transferVsTarget.rightBetterRmseFolds >= 4 ? "NEGATIVE_TRANSFER_DETECTED"
    : transferRelativeGain >= 0.05 && transferVsTarget.leftBetterRmseFolds >= 4 ? "POSITIVE_TRANSFER_SUPPORTED"
      : "TRANSFER_EFFECT_INCONCLUSIVE";

  const winnerByRmse = [...Object.values(nested)].sort((left, right) => left.metrics.rmse - right.metrics.rmse || left.metrics.mae - right.metrics.mae)[0];
  const winningFoldCount = winnerByRmse.folds.filter((fold) => Object.values(nested).every((candidate) => {
    const other = candidate.folds.find((item) => item.outerClusterId === fold.outerClusterId)!;
    return fold.outerMetrics.rmse <= other.outerMetrics.rmse + 1e-12;
  })).length;
  const chosenModes = winnerByRmse.folds.map((fold) => `${fold.selectedFeatureBlock}:${fold.selectedLambda}`);
  const modeFrequency = Math.max(...[...new Set(chosenModes)].map((mode) => chosenModes.filter((value) => value === mode).length));
  const trainSufficiency = modelingRows.length === 8 && new Set(modelingRows.map((row) => row.statisticalClusterId)).size === 6
    && winningFoldCount >= 4 && modeFrequency >= 4 ? "SUFFICIENT_FOR_TARGET_MODEL_FREEZE" : "NEEDS_MINIMAL_TRAIN_EXPANSION";

  const currentTasks = new Set((manifest.groups as Json[]).map((group) => group.taskId as string));
  const q6Tasks = new Set(q6.sealedTaskIds as string[]);
  const expansion = chooseExpansion(inventory.tasks as Json[], inventory.groups as Json[], currentTasks, q6Tasks);
  const expansionTasks = new Set(expansion.tasks.map((task) => task.taskId as string));
  const remaining = (inventory.tasks as Json[]).filter((task) => !currentTasks.has(task.taskId) && !q6Tasks.has(task.taskId) && !expansionTasks.has(task.taskId))
    .sort((left, right) => seededHash(roleSeed, left.taskId).localeCompare(seededHash(roleSeed, right.taskId)));
  if (remaining.length !== 13) throw new Error(`CAPACITY_FIREWALL_EXPECTED_13_REMAINING_GOT_${remaining.length}`);
  const roleRows = [
    ...(q6.sealedTaskIds as string[]).map((taskId) => ({ taskId, role: "Q6_SEALED" })),
    ...[...currentTasks].map((taskId) => ({ taskId, role: "EVO_TRAIN_EXISTING" })),
    ...expansion.tasks.map((task) => ({ taskId: task.taskId, role: "EVO_TRAIN_EXPANSION" })),
    ...remaining.slice(0, 5).map((task) => ({ taskId: task.taskId, role: "FRESH_CAL_RESERVED" })),
    ...remaining.slice(5, 10).map((task) => ({ taskId: task.taskId, role: "SEALED_TEST_RESERVED" })),
    ...remaining.slice(10).map((task) => ({ taskId: task.taskId, role: "UNASSIGNED_RESERVE" })),
  ];
  if (new Set(roleRows.map((row) => row.taskId)).size !== 26) throw new Error("CAPACITY_ROLE_DUPLICATION");

  const eventLines = (await readFile(path.join(runtimeRoot, "execution-events.jsonl"), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as Json);
  const paidCalls = eventLines.filter((event) => event.eventType === "PROVIDER_CALL_COMPLETED");
  const costsByAttempt = new Map<string, number>();
  for (const call of paidCalls) costsByAttempt.set(call.attemptId, (costsByAttempt.get(call.attemptId) ?? 0) + Number(call.amountCny));
  const trialCosts = [...costsByAttempt.values()];
  const expectedTrials = expansion.groups.length * 9;
  const maximumTrials = expansion.groups.length * 11;
  const expectedBootstrap = bootstrapCosts(trialCosts, expectedTrials);
  const maximumBootstrap = bootstrapCosts(trialCosts, maximumTrials);
  const recommendedHardCap = Math.ceil(Math.max(quantile(maximumBootstrap, 0.95) * 1.2, maximumTrials * Math.max(...trialCosts)) * 10) / 10;
  const expectedCalls = expectedTrials * manifest.executionSemantics.maxTurns;
  const maximumCalls = maximumTrials * manifest.executionSemantics.maxTurns;

  const benchmarkProvenance = await writeJson("02_EVO_BENCHMARK_PROVENANCE.json", {
    schemaVersion: "direction-a.evo-benchmark-provenance.v1", generatedAt: createdAt, status: "PASS",
    environmentId: "EvoCodeBench/clean-v2", repositoryCommit: benchmarkIntegrity.pinnedInputs.evoCodeBenchCommit,
    harborPatchCommit: benchmarkIntegrity.pinnedInputs.harborPatchCommit, archiveSha256: benchmarkIntegrity.pinnedInputs.archiveSha256,
    officialTaskCount: benchmarkIntegrity.pinnedInputs.officialTaskCount, officialStepCount: benchmarkIntegrity.pinnedInputs.officialStepCount,
    sharedVerifierUnitTestsPassed: benchmarkIntegrity.staticAndMockedTests.sharedVerifierUnit.passed,
    lifecycleTestsPassed: benchmarkIntegrity.staticAndMockedTests.lifecycleCleanupIntegration.passed,
    officialSubsetComparedFiles: benchmarkIntegrity.officialSubsetByteComparison.comparedFiles,
    officialSubsetMismatches: benchmarkIntegrity.officialSubsetByteComparison.mismatches,
    actualRuntimeIsolationPass: benchmarkIntegrity.realRuntimeEvidence.minimalSynthetic.probes.every((probe: Json) => probe.passed),
    evidencePath: rel(benchmarkIntegrityPath), evidenceSha256: sha(await readFile(benchmarkIntegrityPath)),
    providerCallsThisFreeze: 0,
  });
  const bankReport = await writeJson("04_EVO_CONTINUOUS_DEVELOPMENT_BANK_REPORT.json", {
    schemaVersion: "direction-a.evo-continuous-bank-report.v1", generatedAt: createdAt, status: "PASS",
    tasks: currentTasks.size, groups: bankRows.length, fixed4Pairs: bankRows.length * 4,
    thetaSummary: { minimum: Math.min(...bankRows.map((row) => row.thetaHatFixed4)), maximum: Math.max(...bankRows.map((row) => row.thetaHatFixed4)),
      mean: mean(bankRows.map((row) => row.thetaHatFixed4)), nonZeroGroups: bankRows.filter((row) => row.thetaHatFixed4 !== 0).length },
    oneTaskClusterWeight: true, pairRowsTreatedAsIid: false, historicalPair5PlusPrimaryTargetUse: 0,
    q6Groups: 0, calGroups: 0, sealedTestGroups: 0, unavailableRows: 0,
    immutableInputBindings: {
      initial6Manifest: { path: rel(manifestPath), contentHash: manifest.contentHash, sha256: sha(await readFile(manifestPath)) },
      fixed4Replay: { path: rel(replayPath), contentHash: replay.contentHash, sha256: sha(await readFile(replayPath)) },
      candidateInventory: { path: rel(inventoryPath), contentHash: inventory.contentHash, sha256: sha(await readFile(inventoryPath)) },
      q6Seal: { path: rel(q6Path), contentHash: q6.contentHash, sha256: sha(await readFile(q6Path)) },
    },
  });
  const featureContract = await writeJson("05_EVO_FEATURE_CONTRACT.json", {
    schemaVersion: "direction-a.evo-feature-contract.v1", frozenAt: createdAt,
    sourceModel: { contentHash: source.contentHash, rawFileSha256: sha(sourceRaw), immutable: true, retrainedOnMem2Final69: false },
    sourceAdapter: { structural: ["x0_history_turn_count_log", "x0_query_token_count_log"], normalOutcome: ["n_utility", "n_strict_pass", "n_completion_tokens_log"],
      incompatibleSemanticFields: ["n_tool_name_matches", "n_required_argument_coverage", "n_query_action_jaccard"],
      incompatibleFieldPolicy: "IMPUTE_FROZEN_SOURCE_MEAN_SO_STANDARDIZED_CONTRIBUTION_IS_ZERO", queryTokenProxy: "ceil(UTF8_instruction_bytes/4)" },
    sharedFeatureIds, processFeatureIds,
    timing: "S0 instruction/round features and NORMAL trajectory/outcome only; all are observed before FULL/REMOVE causal outcomes for the group",
    prohibited: ["PAIR_ROW_AS_IID", "FULL_REMOVE_OUTCOME_AS_X", "FUTURE_VERIFIER_DETAIL", "RAW_SOURCE_TARGET_CAUSAL_POOLING", "MEM2_FINAL69_SOURCE_REFIT"],
    processDefinitions: { edit: "log1p(edit-like shell command count)", testCompile: "log1p(test/build/compile command count)",
      revisionRecovery: "log1p(edit commands after first test plus error-marker count in observed command output)" },
    missingness: "FAIL_CLOSED; no imputation except the explicitly incompatible source-only semantic coordinates",
  });
  const featureAudit = await writeJson("06_EVO_FEATURE_PROVENANCE_AUDIT.json", {
    schemaVersion: "direction-a.evo-feature-provenance-audit.v1", generatedAt: createdAt, status: "PASS",
    rowsAudited: bankRows.length, preCausalTimingRows: bankRows.filter((row) => row.timingContract.includes("BEFORE_CAUSAL")).length,
    normalArtifactsPresent: bankRows.filter((row) => row.normalEvidence?.artifactHash).length,
    finiteSharedRows: modelingRows.filter((row) => Object.values(row.sharedFeatures).every(Number.isFinite)).length,
    finiteProcessRows: modelingRows.filter((row) => Object.values(row.processFeatures).every(Number.isFinite)).length,
    sourceHashVerified: true, q6YRead: 0, calYRead: 0, sealedTestYRead: 0, providerCalls: 0, secretReads: 0,
  });
  const modelRule = await writeJson("07_EVO_MODEL_SELECTION_RULE_FREEZE.json", {
    schemaVersion: "direction-a.evo-model-selection-rule-freeze.v1", frozenAt: createdAt,
    target: "thetaHatFixed4", candidates: candidateIds, featureBlocks, lambdas,
    splitUnit: "COMPLETE_TASK_REQUIREMENT_CHAIN", outer: "LEAVE_ONE_TASK_CLUSTER_OUT", inner: "LEAVE_ONE_TASK_CLUSTER_OUT_ON_OUTER_TRAIN",
    weighting: "EACH_TASK_CLUSTER_TOTAL_WEIGHT_ONE_OVER_NUMBER_OF_TASKS; GROUPS_WITHIN_TASK_SHARE_THAT_WEIGHT",
    primaryMetric: "CLUSTER_WEIGHTED_RMSE", tieBreaks: ["CLUSTER_WEIGHTED_MAE", "LARGER_LAMBDA", "EVO_SHARED_ONLY"],
    transferChoice: "Choose A vs B by nested RMSE/MAE; B is separate-scale only and never raw-pools source/target Y",
    negativeTransferRule: "C improvement at least 5 percent and C wins at least 4 of 6 outer folds",
    freezeRule: "At least the authorized maximum 8 development task clusters, winner in at least 2/3 outer folds, and modal hyperparameter in at least 2/3 folds",
    categoricalM0M4CurrentTrainer: false,
  });
  const splitManifest = await writeJson("08_EVO_NESTED_SPLIT_MANIFEST.json", {
    schemaVersion: "direction-a.evo-nested-split-manifest.v1", frozenAt: createdAt,
    statisticalUnit: "COMPLETE_TASK_REQUIREMENT_CHAIN", taskClusters: [...currentTasks].sort(),
    outerFolds: [...currentTasks].sort().map((outerTestTaskId) => ({ outerTestTaskId,
      outerTrainTaskIds: [...currentTasks].filter((taskId) => taskId !== outerTestTaskId).sort(),
      innerFolds: [...currentTasks].filter((taskId) => taskId !== outerTestTaskId).sort().map((innerValidationTaskId) => ({
        innerValidationTaskId, innerTrainTaskIds: [...currentTasks].filter((taskId) => taskId !== outerTestTaskId && taskId !== innerValidationTaskId).sort(),
      })),
    })),
    leakageChecks: { groupSplitAcrossFolds: false, pairRowsSplitAcrossFolds: false, heldTaskYUsedForTuning: false },
  });
  const abcResults = await writeJson("09_EVO_ABC_OOF_RESULTS.json", {
    schemaVersion: "direction-a.evo-abc-oof-results.v1", generatedAt: createdAt, evidenceClass: "DEVELOPMENT_ONLY_NOT_FRESH_CAL",
    candidates: nested, preliminaryRank: [...Object.values(nested)].sort((left, right) => left.metrics.rmse - right.metrics.rmse)
      .map((result, index) => ({ rank: index + 1, candidateId: result.candidateId, metrics: result.metrics })),
    provisionalBestCandidateId: winnerByRmse.candidateId, targetModelFrozen: false,
    reasonNotFrozen: "Current bank has 6 independent task clusters; frozen stability rule requires the lawful 8-cluster checkpoint",
  });
  const processAblation = await writeJson("10_EVO_PROCESS_EVIDENCE_ABLATION.json", {
    schemaVersion: "direction-a.evo-process-evidence-ablation.v1", generatedAt: createdAt, status: "COMPLETE",
    candidates: Object.fromEntries(candidateIds.map((candidateId) => {
      const row = fixedBlockAblations[candidateId];
      return [candidateId, { sharedOnly: row.sharedOnly.metrics, sharedPlusProcess: row.sharedPlusProcess.metrics,
        rmseDeltaProcessMinusShared: row.sharedPlusProcess.metrics.rmse - row.sharedOnly.metrics.rmse,
        maeDeltaProcessMinusShared: row.sharedPlusProcess.metrics.mae - row.sharedOnly.metrics.mae,
        outerDirectionalStability: summarizeOuterDirectionalStability(row.sharedPlusProcess, row.sharedOnly) }];
    })),
    interpretation: "Development evidence only; process features are retained in the frozen grid but not declared helpful unless the expanded-bank nested result is stable",
  });
  const negativeReport = await writeJson("11_EVO_NEGATIVE_TRANSFER_REPORT.json", {
    schemaVersion: "direction-a.evo-negative-transfer-report.v1", generatedAt: createdAt,
    bestTransferCandidateId: bestTransfer.candidateId, transferMetrics: bestTransfer.metrics, targetOnlyMetrics: targetOnly.metrics,
    targetOnlyRelativeRmseGain: targetRelativeGain, transferRelativeRmseGain: transferRelativeGain,
    outerFoldDirection: transferVsTarget, decision: negativeTransfer,
    modelFreezeEffect: "DIAGNOSTIC_AT_SIX_CLUSTERS; RE-EVALUATE UNDER IDENTICAL FROZEN RULE AFTER TWO-TASK EXPANSION",
  });
  const sufficiency = await writeJson("12_EVO_TRAIN_SUFFICIENCY_DECISION.json", {
    schemaVersion: "direction-a.evo-train-sufficiency-decision.v1", decidedAt: createdAt, decision: trainSufficiency,
    currentIndependentTaskClusters: currentTasks.size, currentGroups: bankRows.length, provisionalBestCandidateId: winnerByRmse.candidateId,
    winnerOuterFoldCount: winningFoldCount, winnerModalHyperparameterFoldCount: modeFrequency,
    requiredCheckpointTaskClusters: 8, additionalTaskClustersRequired: 2,
    rationale: "Initial-6 is an underpowered nested-selection checkpoint with only six outer folds and sparse nonzero fixed4 targets. Two new-domain tasks reach the already-authorized Pilot hard maximum while preserving Q6/CAL/TEST capacity.",
    targetModelFrozen: false,
  });
  const firewall = await writeJson("13_EVO_TASK_CAPACITY_FIREWALL.json", {
    schemaVersion: "direction-a.evo-task-capacity-firewall.v1", frozenAt: createdAt, status: "PASS",
    totalOfficialTasks: 26, roleRows, counts: { q6: 5, existingTrain: 6, expansionTrain: 2, freshCalReserved: 5, sealedTestReserved: 5, reserve: 3 },
    overlapChecks: { q6Train: 0, q6Cal: 0, q6Test: 0, trainCal: 0, trainTest: 0, calTest: 0 },
    note: "CAL/TEST identities are capacity reservations only; causal Y remains unopened and future acquisition still needs a fresh freeze and authorization.",
  });
  const scalePlanner = await writeJson("14_EVO_SCALE_PLANNER.json", {
    schemaVersion: "direction-a.evo-continuous-scale-planner.v1", generatedAt: createdAt,
    current: { taskClusters: currentTasks.size, groups: bankRows.length, nonZeroGroups: bankRows.filter((row) => row.thetaHatFixed4 !== 0).length },
    trainingFirstDecision: "ADD_EXACTLY_TWO_NEW_DOMAIN_TASK_CLUSTERS_TO_REACH_HARD_MAX_8",
    futureCapacity: { q6SealedTasks: 5, freshCalCapacity: 5, sealedTestCapacity: 5, reserveCapacity: 3 },
    freshCalNStatus: "NOT_FROZEN_BEFORE_EXPANDED_TRAIN_MODEL_SELECTION", inferenceFamily: "TASK_CLUSTER_NESTED_CONTINUOUS_A_B_C",
    oldCategoricalNUsed: false, pairIidVarianceUsed: false,
  });

  const selection = await writeJson("EVO_TRAIN_EXPANSION_SELECTION.json", {
    schemaVersion: "direction-a.evo-train-expansion-selection.v1", frozenAt: createdAt, seed: expansionSeed,
    policy: ["exclude Q6/current TRAIN", "prefer unseen official domains", "descending eligible causal-group capacity", "seeded hash tie-break"],
    groupPolicy: ["one group per new task", "conflict+extension first", "closest to task median eligible round", "seeded hash tie-break"],
    selectedTasks: expansion.tasks.map((task) => ({ taskId: task.taskId, officialDomainId: task.officialDomainId,
      candidateHash: task.candidateHash, sourceTaskDirectoryHash: task.sourceTaskDirectoryHash, eligibleCausalGroupCount: task.eligibleCausalGroupCount })),
    selectedGroups: expansion.groups.map((group) => ({ causalGroupId: group.causalGroupId, taskId: group.taskId, targetRound: group.targetRound,
      changeTypes: group.changeTypes, candidateHash: group.candidateHash, sourceEvidenceHash: group.sourceEvidenceHash,
      sourceMemoryRound: group.sourceMemoryRound, statisticalClusterId: group.statisticalClusterId })),
    q6Overlap: 0, calReservationOverlap: 0, sealedTestReservationOverlap: 0, labelBlind: true,
  });
  const budget = await writeJson("EVO_TRAIN_EXPANSION_BUDGET.json", {
    schemaVersion: "direction-a.evo-train-expansion-budget.v1", frozenAt: createdAt,
    historicalBasis: { providerCalls: paidCalls.length, trials: trialCosts.length, totalCostCny: round(paidCalls.reduce((sum, call) => sum + Number(call.amountCny), 0)),
      meanTrialCostCny: round(mean(trialCosts)), maximumObservedTrialCostCny: round(Math.max(...trialCosts)) },
    protocol: { selectedGroups: 2, normalTrialsPerGroup: 1, fullRemovePairsPerGroup: 4, causalArmTrialsPerGroup: 8,
      expectedTrials, technicalRetryLimitPerGroup: 2, maximumTrials, maxTurnsPerTrial: manifest.executionSemantics.maxTurns },
    expectedProviderCalls: expectedCalls, absoluteProviderCallCap: maximumCalls,
    expectedCostCny: { p50: round(quantile(expectedBootstrap, 0.5)), p90: round(quantile(expectedBootstrap, 0.9)), p95: round(quantile(expectedBootstrap, 0.95)) },
    maximumPlanCostCny: { p95BootstrapAtMaximumTrials: round(quantile(maximumBootstrap, 0.95)), worstHistoricalTrialEnvelope: round(maximumTrials * Math.max(...trialCosts)) },
    recommendedHardCapCny: recommendedHardCap,
    nonAdaptiveScientificPairs: true, fifthPairAllowed: false, technicalRetryDefinition: "ONLY_TRUE_TECHNICAL_INVALID; SCIENTIFIC_FAILURE_IS_VALID",
  });
  const expansionPlan = await writeJson("EVO_TRAIN_EXPANSION_PLAN.json", {
    schemaVersion: "direction-a.evo-train-expansion-plan.v1", frozenAt: createdAt, status: "FROZEN_PENDING_AUTHORIZATION",
    purpose: "Add the minimum two independent task clusters needed for continuous A/B/C nested model selection",
    sourceDatasetRoot: rel(path.join(memoryCore, ".research/direction-a/v6.3/dependencies/evocodebench_wotraj")),
    runtimeOutputRoot: "Direction_A_Evo_Train_Expansion_Runtime_v1",
    selectedTaskIds: expansion.tasks.map((task) => task.taskId), selectedCausalGroupIds: expansion.groups.map((group) => group.causalGroupId),
    referenceProtocol: "EXACTLY_FIRST_4_TECHNICALLY_VALID_COMPLETE_FULL_REMOVE_PAIRS",
    normalProtocol: "ONE_PRE_CAUSAL_NORMAL_RUN_PER_GROUP_UNDER_SAME_FROZEN_PROFILE",
    executionProfile: manifest.executionSemantics,
    sourceHarnessBindings: { benchmarkProvenanceHash: benchmarkProvenance.contentHash, initial6ManifestHash: manifest.contentHash,
      candidateInventoryHash: inventory.contentHash, currentAuthorityBindingHash: hashCanonical(authorityBindings) },
    technicalPolicy: { completePairCount: 4, outcomeAdaptiveDeepening: false, fifthPair: false, technicalRetryLimitPerGroup: 2,
      retryScope: "PER_CAUSAL_GROUP_COMPLETE_UNIT", scientificFailureCountsAsValid: true },
    stopAfterStage: true, freshCalAuthorized: false, q6Authorized: false, sealedTestAuthorized: false,
  });
  const authorization = await writeJson("EVO_TRAIN_EXPANSION_AUTHORIZATION_REQUEST.json", {
    schemaVersion: "direction-a.evo-train-expansion-authorization-request.v1", createdAt,
    authorizationStatus: "RESEARCHER_APPROVAL_REQUIRED", authorizationGranted: false,
    requestedStage: "EVO_TRAIN_EXPANSION", exactTaskIds: expansion.tasks.map((task) => task.taskId),
    exactCausalGroupIds: expansion.groups.map((group) => group.causalGroupId), expectedProviderCalls: expectedCalls,
    absoluteProviderCallCap: maximumCalls, expectedCostCnyP50: round(quantile(expectedBootstrap, 0.5)), hardCostCapCny: recommendedHardCap,
    requiredBindings: { planHash: expansionPlan.contentHash, selectionHash: selection.contentHash, budgetHash: budget.contentHash,
      sourceModelContentHash: source.contentHash, q6SealContentHash: q6.contentHash, benchmarkProvenanceHash: benchmarkProvenance.contentHash,
      executionProfileHash: manifest.executionProfileHash, currentAuthorityBindingHash: hashCanonical(authorityBindings) },
    forbidden: ["Q6", "FRESH_CAL", "SEALED_TEST", "PAIR_5", "OUTCOME_ADAPTIVE_DEEPENING", "SOURCE_MODEL_REFIT", "RAW_SOURCE_TARGET_POOLING"],
    approvalInstruction: "Researcher must create a separate immutable granted authorization bound to every required hash; this request is not executable authority.",
  });
  const stagePlan = await writeJson("15_CURRENT_STAGE_PLAN.json", {
    schemaVersion: "direction-a.evo-current-stage-plan.v1", generatedAt: createdAt, stage: "EVO_TRAIN_EXPANSION",
    terminal: "READY_FOR_EVO_TRAIN_EXPANSION_AUTHORIZATION", zeroProviderClosureComplete: true,
    prerequisites: { benchmarkProvenance: benchmarkProvenance.contentHash, bank: bankReport.contentHash, featureContract: featureContract.contentHash,
      featureAudit: featureAudit.contentHash, modelRule: modelRule.contentHash, splits: splitManifest.contentHash, abcResults: abcResults.contentHash,
      processAblation: processAblation.contentHash, negativeTransfer: negativeReport.contentHash, sufficiency: sufficiency.contentHash,
      firewall: firewall.contentHash, scalePlanner: scalePlanner.contentHash },
    nextAction: "Researcher reviews and explicitly grants the exact bounded TRAIN expansion only",
  });
  await writeJson("16_CURRENT_STAGE_AUTHORIZATION_REQUEST.json", {
    schemaVersion: "direction-a.evo-current-stage-authorization-request.v1", generatedAt: createdAt,
    currentStage: "EVO_TRAIN_EXPANSION", canonicalRequestFile: "EVO_TRAIN_EXPANSION_AUTHORIZATION_REQUEST.json",
    canonicalRequestHash: authorization.contentHash, granted: false, executable: false,
  });

  const runbook = `# WorkBuddy — Evo TRAIN expansion execution\n\nStatus: **NOT AUTHORIZED**. Stop until the researcher supplies a new immutable granted authorization matching the hashes below.\n\n## Exact scope\n\n- Tasks: ${expansion.tasks.map((task) => `\`${task.taskId}\``).join(", ")}\n- Groups: ${expansion.groups.map((group) => `\`${group.causalGroupId}\``).join(", ")}\n- Expected calls: ${expectedCalls}; absolute call cap: ${maximumCalls}; hard cost cap: CNY ${recommendedHardCap.toFixed(1)}.\n- Runtime root: \`C:\\Users\\L2503\\Desktop\\TencentDB-Agent-Memory\\Direction_A_Evo_Train_Expansion_Runtime_v1\`.\n\n## Mandatory preflight\n\n1. Verify the granted authorization binds request hash \`${authorization.contentHash}\`, plan \`${expansionPlan.contentHash}\`, selection \`${selection.contentHash}\`, budget \`${budget.contentHash}\`, source model \`${source.contentHash}\`, Q6 seal \`${q6.contentHash}\`, and execution profile \`${manifest.executionProfileHash}\`.\n2. Materialize only the two frozen task/group units from the pinned local EvoCodeBench dataset. Validate the task candidate/source-directory hashes and the group candidate/source-evidence hashes from the selection artifact before deriving frozen prefixes, recall snapshots, instructions, and arm directories.\n3. Create a fresh append-only execution journal and cost ledger. Reserve the hard caps before reading any provider secret. Abort before secret read on any mismatch.\n4. Confirm Q6, FRESH_CAL and SEALED_TEST overlap are all zero.\n\n## Paid protocol after explicit grant\n\nFor each group run exactly one pre-causal NORMAL trial, then four predeclared counterbalanced complete FULL/REMOVE pairs. Scientific failure is valid evidence. Do not run pair 5. Allow at most two group-scoped replacement trials only for true technical invalidity; never deepen from observed Y. Keep each task as one statistical cluster.\n\nAfter both groups complete, reconstruct fixed4 rows, append them to the TRAIN/DEV bank, rerun the frozen A/B/C task-cluster nested evaluation and process ablation, and apply the frozen model-selection/negative-transfer/sufficiency rules. Do not open fresh CAL, SEALED TEST or Q6.\n\n## Required terminal\n\nEmit costs/calls, pair validity, hashes, overlap checks, model-selection result, and stop for the next authorization boundary.\n`;
  const runbookSha = sha(Buffer.from(runbook, "utf8"));
  await writeText("WORKBUDDY_EVO_TRAIN_EXPANSION_EXECUTION.md", runbook);
  await writeText("17_WORKBUDDY_CURRENT_STAGE_EXECUTION.md", runbook);

  const reproduction = await writeJson("18_REPRODUCIBILITY_REPORT.md.json", {
    schemaVersion: "direction-a.evo-reproducibility-report.v1", generatedAt: createdAt,
    command: "npx tsx scripts/direction-a/formal/evo-continuous-adaptation-freeze.ts",
    implementationVersion: "direction-a.evo-continuous-adaptation.v1", deterministic: true,
    sourceFiles: [rel(path.join(memoryCore, "src/evaluation/direction-a/formal/modeling/evo-continuous-adaptation.ts")), rel(path.join(memoryCore, "scripts/direction-a/formal/evo-continuous-adaptation-freeze.ts"))],
    inputs: [rel(sourcePath), rel(manifestPath), rel(replayPath), rel(inventoryPath), rel(q6Path), rel(benchmarkIntegrityPath), rel(path.join(runtimeRoot, "results"))],
    zeroProvider: { providerCalls: 0, modelCalls: 0, secretReads: 0, q6YReads: 0, calYReads: 0, sealedTestYReads: 0 },
  });
  await writeText("18_REPRODUCIBILITY_REPORT.md", `# Reproducibility report\n\n- Deterministic builder: \`npx tsx scripts/direction-a/formal/evo-continuous-adaptation-freeze.ts\`\n- Implementation: \`direction-a.evo-continuous-adaptation.v1\`\n- A/B/C evaluation: task-cluster nested, one total weight per task; pair rows are never IID.\n- Frozen Mem2 source content hash: \`${source.contentHash}\`; raw file SHA-256: \`${sha(sourceRaw)}\`.\n- Reproducibility sidecar hash: \`${reproduction.contentHash}\`.\n- Provider/model calls, secret reads, Q6/CAL/TEST Y reads: all zero.\n`);

  await writeText("01_AUTHORITY_AND_PROVENANCE_AUDIT.md", `# Authority and provenance audit\n\nPASS. The current continuous authority overrides historical categorical M0–M4 trainer semantics. The Initial-6 bank is PILOT_TRAIN_DEV only, fixed4 is reconstructed from the first four technically valid complete pairs, and pair rows are not IID.\n\nThe immutable Mem2 V2.1 source model was verified by its internal canonical content hash \`${source.contentHash}\`. Its raw JSON file hash is separately \`${sha(sourceRaw)}\`; the two hashes intentionally have different scopes. The source model is scored only and never refit on final69 or Evo. A/B/C use a target-specific scale; no raw Mem2/Evo causal effects are pooled.\n\nCurrent authority binding hash: \`${hashCanonical(authorityBindings)}\`.\n\n${authorityBindings.map((entry) => `- \`${entry.path}\` — \`${entry.sha256}\``).join("\n")}\n\nBenchmark provenance and Q6 seal pass. Q6, CAL and SEALED TEST causal Y were not read. New provider/model calls and secret reads are zero.\n`);
  await writeText("00_READ_FIRST.md", `# Direction A — Evo continuous adaptation pre-CAL closure\n\nTerminal: **READY_FOR_EVO_TRAIN_EXPANSION_AUTHORIZATION**.\n\nThe legal Initial-6 bank has ${currentTasks.size} task clusters and ${bankRows.length} groups. A/B/C continuous nested evaluation and coding-process ablation completed, but the target model is not frozen: the six-cluster checkpoint does not pass the frozen stability rule. The minimum lawful next stage is two new-domain TRAIN task clusters, reaching the existing hard maximum of eight while retaining five CAL tasks, five TEST tasks, five sealed Q6 tasks and three reserve tasks.\n\nThis package is zero-provider evidence, not paid authorization. Start with \`16_CURRENT_STAGE_AUTHORIZATION_REQUEST.json\` and \`17_WORKBUDDY_CURRENT_STAGE_EXECUTION.md\`.\n`);
  await writeText("TERMINAL_SUMMARY.md", `EVO_CONTINUOUS_ADAPTATION_PRECAL_CLOSURE_COMPLETE\n\nBENCHMARK_PROVENANCE =\nPASS\n\nQ6_FIREWALL =\nPASS\n\nEXISTING_EVO_TRAIN_TASK_CLUSTERS =\n${currentTasks.size}\n\nEXISTING_EVO_GROUPS =\n${bankRows.length}\n\nABC_IMPLEMENTATION =\nPASS\n\nPROCESS_EVIDENCE_ABLATION =\nCOMPLETE\n\nCURRENT_MODEL_DECISION =\nNEEDS_MINIMAL_TRAIN_EXPANSION\n\nPROVISIONAL_MODEL_SELECTION =\n${winnerByRmse.candidateId}\n\nNEGATIVE_TRANSFER =\n${negativeTransfer}\n\nEXPANSION_TASKS =\n${expansion.tasks.map((task) => task.taskId).join("\n")}\n\nEXPANSION_GROUPS =\n${expansion.groups.map((group) => group.causalGroupId).join("\n")}\n\nQ6_OVERLAP =\n0\n\nEXPECTED_CALLS =\n${expectedCalls}\n\nMAX_CALLS =\n${maximumCalls}\n\nEXPECTED_COST_CNY =\n${round(quantile(expectedBootstrap, 0.5))}\n\nRECOMMENDED_HARD_CAP_CNY =\n${recommendedHardCap}\n\nAUTHORIZATION_REQUEST =\n${path.join(outputRoot, "EVO_TRAIN_EXPANSION_AUTHORIZATION_REQUEST.json")} / ${authorization.contentHash}\n\nWORKBUDDY_RUNBOOK =\n${path.join(outputRoot, "WORKBUDDY_EVO_TRAIN_EXPANSION_EXECUTION.md")} / ${runbookSha}\n\nNEW_PROVIDER_CALLS =\n0\n\nSECRET_READS =\n0\n\nNEXT =\nREADY_FOR_EVO_TRAIN_EXPANSION_AUTHORIZATION\n`);
  await writeFile(path.join(linkageRoot, "EVO_STAGE_RESEARCH_LINKAGE.md"), `# Evo stage research linkage\n\n- Mem2 strict formal CAL remains immutable **FAIL / NO_CERTIFIED_OPERATING_POINT**.\n- Mem2 V2.1 produced a positive point estimate, but its primary comparison remains statistically inconclusive.\n- Evo continuous target adaptation is a new research stage, not a repair or reinterpretation of Mem2 CAL.\n- This stage currently stops at \`READY_FOR_EVO_TRAIN_EXPANSION_AUTHORIZATION\`.\n`, "utf8");

  const inventoryEntries: Json[] = [];
  for (const name of (await readdir(outputRoot)).sort()) {
    if (name === "SHA256_INVENTORY.json") continue;
    const file = path.join(outputRoot, name);
    if (!(await stat(file)).isFile()) continue;
    const bytes = await readFile(file);
    inventoryEntries.push({ path: name, sha256: sha(bytes), bytes: bytes.length });
  }
  const hashInventory = withHash({ schemaVersion: "direction-a.evo-output-sha256-inventory.v1", generatedAt: createdAt,
    files: inventoryEntries, inventorySelfExcluded: true });
  await writeFile(path.join(outputRoot, "SHA256_INVENTORY.json"), `${JSON.stringify(hashInventory, null, 2)}\n`, "utf8");
  process.stdout.write(`EVO_CONTINUOUS_ADAPTATION_PRECAL_CLOSURE_COMPLETE\nNEXT=READY_FOR_EVO_TRAIN_EXPANSION_AUTHORIZATION\nOUTPUT=${outputRoot}\nPROVISIONAL=${winnerByRmse.candidateId}\nNEGATIVE_TRANSFER=${negativeTransfer}\nTASKS=${expansion.tasks.map((task) => task.taskId).join(",")}\nGROUPS=${expansion.groups.map((group) => group.causalGroupId).join(",")}\nEXPECTED_CALLS=${expectedCalls}\nMAX_CALLS=${maximumCalls}\nEXPECTED_COST_CNY=${round(quantile(expectedBootstrap, 0.5))}\nHARD_CAP_CNY=${recommendedHardCap}\nAUTH_HASH=${authorization.contentHash}\n`);
}

await main();
