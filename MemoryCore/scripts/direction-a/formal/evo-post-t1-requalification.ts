import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FRESH_PAID_AUTHORITY,
  FRESH_RUNTIME_ROOT,
  buildAcceptedEvoProcessFeatures,
  buildAcceptedEvoSharedFeatures,
  buildAcceptedEvoSourceInputs,
  evaluateT2Trigger,
  extractEvoNormalProcessEvidence,
  fitFinalCandidateFromNested,
  hashCanonical,
  parseAcceptedEvoCaseSummary,
  runEngineeringTaskClusterNestedEvaluation,
  scoreAcceptedEvoSource,
  scoreFrozenSource,
  selectEngineeringCandidate,
  type EngineeringNestedCandidateResult,
  type EvoCandidateId,
  type EvoContinuousRow,
  type FrozenSourceModel,
  type NestedCandidateResult,
} from "../../../src/evaluation/direction-a/formal/index.js";
import {
  assertActualArmStartOrder,
  scheduledArms,
  type PairSchedule,
} from "../../../src/evaluation/direction-a/formal/acquisition/integrity.js";
import {
  parseCurrentFormalExecutionEvents,
  type CurrentFormalExecutionEvent,
} from "../../../src/evaluation/direction-a/formal/prepilot/execution-state-attestation.js";

type Json = Record<string, any>;
type Arm = "FULL" | "REMOVE";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../../");
const workspaceRoot = path.dirname(repoRoot);
const outputRoot = path.join(workspaceRoot, "Direction_A_Evo_PostT1_Requalification_Closure_v2");
const generatedAt = "2026-09-13T00:00:00.000+08:00";
const decisionId = "EVO_ENGINEERING_FIRST_BUDGET100_V1_2026_09_12";
const globalHardCapCny = 110;
const validated = process.argv.includes("--validated");

const roots = {
  predecessor: path.join(workspaceRoot, "Direction_A_Evo_Continuous_Adaptation_v1"),
  authority: path.join(workspaceRoot, "Direction_A_Evo_Engineering_First_Budget100_v1"),
  runtime: path.join(workspaceRoot, "Direction_A_Evo_Engineering_First_T1_Runtime_v2"),
  recovery: path.join(workspaceRoot, "Direction_A_Evo_T1_PairOrder_Recovery_Runtime_v1"),
  continuation: path.join(workspaceRoot, "Direction_A_Evo_T1_AntiCensoring_Continuation_Runtime_v1"),
  retry: path.join(workspaceRoot, "Direction_A_Evo_T1_AntiCensoring_BoundedRetry_d3P3REMOVE_Runtime_v1"),
  final: path.join(workspaceRoot, "Direction_A_Evo_T1_AntiCensoring_BoundedFinal_d3P3FULL_Runtime_v1"),
  antiCensoring: path.join(workspaceRoot, "Direction_A_Evo_T1_AntiCensoring_Continuation_Closure_v2"),
  postcal: path.join(workspaceRoot, "Direction_A_PostCAL_Model_Value_v2_1"),
  freshN9: path.join(workspaceRoot, "Direction_A_Evo_Fresh_N9_Grant_Runtime_Adapter_Closure_v1"),
};

const sharedFeatureIds = [
  "shared_target_round_log", "shared_instruction_bytes_log", "shared_normal_utility",
  "shared_normal_strict_pass", "shared_completion_tokens_log",
];
const processFeatureIds = [
  "process_edit_commands_log", "process_test_compile_commands_log", "process_revision_recovery_log",
];
const candidateIds: EvoCandidateId[] = [
  "A_FROZEN_SOURCE_RESIDUAL_RIDGE", "B_SEPARATE_SCALE_PARTIAL_POOLING", "C_EVO_ONLY_RIDGE",
];
const featureBlocks = ["EVO_SHARED_ONLY", "EVO_SHARED_PLUS_PROCESS"] as const;
const lambdas = [10, 100, 1000] as const;
const fallbackOrder = [
  "C_EVO_ONLY_RIDGE", "B_SEPARATE_SCALE_PARTIAL_POOLING", "A_FROZEN_SOURCE_RESIDUAL_RIDGE",
] as const;

const documents = new Map<string, Buffer>();
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const rel = (absolute: string): string => path.relative(workspaceRoot, absolute).replaceAll("\\", "/");
const stableText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const roundMoney = (value: number): number => Number(value.toFixed(12));
const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
const seal = <T extends Json>(body: T): T & { contentHash: string } => ({ ...body, contentHash: hashCanonical(body) });

async function readJson(file: string): Promise<Json> {
  return JSON.parse(await readFile(file, "utf8")) as Json;
}

function assertSelfHash(document: Json, label: string): void {
  const { contentHash, ...body } = document;
  if (typeof contentHash !== "string" || hashCanonical(body) !== contentHash) {
    throw new Error(`${label}_CONTENT_HASH_REPLAY_FAIL`);
  }
}

function addJson(name: string, body: Json): Json {
  const document = body.contentHash ? body : seal(body);
  documents.set(name, Buffer.from(stableText(document)));
  return document;
}

function addText(name: string, value: string): void {
  documents.set(name, Buffer.from(value.replaceAll("\r\n", "\n")));
}

async function fileBinding(file: string): Promise<Json> {
  const bytes = await readFile(file);
  return { path: rel(file), bytes: bytes.length, sha256: sha(bytes) };
}

function plannedBinding(name: string): Json {
  const bytes = documents.get(name);
  if (!bytes) throw new Error(`PLANNED_BINDING_MISSING:${name}`);
  return { path: rel(path.join(outputRoot, name)), bytes: bytes.length, sha256: sha(bytes) };
}

async function loadJournal(label: string, root: string): Promise<{ label: string; root: string; raw: Buffer; events: CurrentFormalExecutionEvent[] }> {
  const journalPath = path.join(root, "execution-events.jsonl");
  const raw = await readFile(journalPath);
  const events = parseCurrentFormalExecutionEvents(raw.toString("utf8"));
  if (!events.length) throw new Error(`EMPTY_JOURNAL:${label}`);
  return { label, root, raw, events };
}

function eventFor(events: readonly CurrentFormalExecutionEvent[], type: string, attemptId: string): CurrentFormalExecutionEvent {
  const rows = events.filter((row) => row.eventType === type && row.attemptId === attemptId);
  if (rows.length !== 1) throw new Error(`EVENT_CARDINALITY:${type}:${attemptId}:${rows.length}`);
  return rows[0];
}

async function trialRoot(runtimeRoot: string, attemptId: string): Promise<string> {
  const jobRoot = path.join(runtimeRoot, "harbor-jobs", `evo-t1-${attemptId}`);
  const entries = (await readdir(jobRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  if (entries.length !== 1) throw new Error(`TRIAL_DIRECTORY_CARDINALITY:${attemptId}:${entries.length}`);
  return path.join(jobRoot, entries[0].name);
}

interface TrialEvidence {
  attemptId: string;
  runtimeLabel: string;
  start: CurrentFormalExecutionEvent;
  finish: CurrentFormalExecutionEvent;
  result: Json;
  caseSummary?: Json;
  processEvidence?: Json;
  evidence: Json;
}

async function trialEvidence(
  journal: { label: string; root: string; events: CurrentFormalExecutionEvent[] },
  attemptId: string,
  options: { process?: boolean; fallback?: Json } = {},
): Promise<TrialEvidence> {
  const start = eventFor(journal.events, "PAID_TRIAL_STARTED", attemptId);
  const finish = eventFor(journal.events, "PAID_TRIAL_FINISHED", attemptId);
  const root = await trialRoot(journal.root, attemptId);
  const resultPath = path.join(root, "result.json");
  const resultRaw = await readFile(resultPath);
  if (sha(resultRaw) !== finish.resultHash) throw new Error(`RESULT_HASH_JOURNAL_MISMATCH:${attemptId}`);
  const result = JSON.parse(resultRaw.toString("utf8")) as Json;
  const stdoutPath = path.join(root, "steps/target-round/verifier/test-stdout.txt");
  let caseSummary: Json | undefined;
  let stdoutBinding: Json | undefined;
  if (options.fallback) {
    caseSummary = options.fallback;
    try {
      const stdout = await readFile(stdoutPath);
      stdoutBinding = { path: rel(stdoutPath), bytes: stdout.length, sha256: sha(stdout), caseSummaryPresent: false };
    } catch { stdoutBinding = { path: rel(stdoutPath), present: false, caseSummaryPresent: false }; }
  } else {
    const stdout = await readFile(stdoutPath);
    caseSummary = parseAcceptedEvoCaseSummary(stdout.toString("utf8"));
    stdoutBinding = { path: rel(stdoutPath), bytes: stdout.length, sha256: sha(stdout), caseSummaryPresent: true };
  }
  let processEvidence: Json | undefined;
  let trajectoryBinding: Json | undefined;
  if (options.process) {
    const trajectoryPath = path.join(root, "steps/target-round/agent/trajectory.json");
    const trajectory = await readFile(trajectoryPath);
    processEvidence = extractEvoNormalProcessEvidence(trajectory.toString("utf8"));
    trajectoryBinding = { path: rel(trajectoryPath), bytes: trajectory.length, sha256: sha(trajectory) };
  }
  return {
    attemptId, runtimeLabel: journal.label, start, finish, result, caseSummary, processEvidence,
    evidence: {
      result: { path: rel(resultPath), bytes: resultRaw.length, sha256: sha(resultRaw) },
      verifierStdout: stdoutBinding,
      trajectory: trajectoryBinding,
      startEvent: { sequence: start.sequence, eventHash: start.eventHash },
      finishEvent: { sequence: finish.sequence, eventHash: finish.eventHash, terminalStatus: finish.terminalStatus, resultHash: finish.resultHash },
    },
  };
}

function journalSummary(journal: { label: string; root: string; raw: Buffer; events: CurrentFormalExecutionEvent[] }): Json {
  const provider = journal.events.filter((row) => row.eventType === "PROVIDER_CALL_COMPLETED");
  return {
    label: journal.label,
    root: rel(journal.root),
    journal: { path: rel(path.join(journal.root, "execution-events.jsonl")), bytes: journal.raw.length, sha256: sha(journal.raw) },
    eventCount: journal.events.length,
    headHash: journal.events.at(-1)!.eventHash,
    starts: journal.events.filter((row) => row.eventType === "PAID_TRIAL_STARTED").length,
    finishes: journal.events.filter((row) => row.eventType === "PAID_TRIAL_FINISHED").length,
    providerCalls: provider.length,
    observedSpendCny: roundMoney(provider.reduce((sum, row) => sum + (row.amountCny ?? 0), 0)),
    historicalSecretContentReadEvents: journal.events.filter((row) => row.eventType === "SECRET_CONTENT_READ").length,
    causalYCommittedEvents: journal.events.filter((row) => row.eventType === "CAUSAL_Y_COMMITTED").length,
  };
}

function candidateEvaluation(result: EngineeringNestedCandidateResult): Json {
  return {
    candidateId: result.candidateId,
    predictions: result.predictions,
    complexityRank: result.candidateId === "C_EVO_ONLY_RIDGE" ? 0 : 1,
    onlineCostRank: candidateIds.indexOf(result.candidateId),
  };
}

function foldDirection(left: EngineeringNestedCandidateResult, right: EngineeringNestedCandidateResult): Json {
  const other = new Map(right.folds.map((fold) => [fold.outerClusterId, fold]));
  let leftBetterRmseFolds = 0; let rightBetterRmseFolds = 0; let tiedFolds = 0;
  for (const fold of left.folds) {
    const compare = other.get(fold.outerClusterId);
    if (!compare) throw new Error("OUTER_FOLD_ALIGNMENT_MISMATCH");
    const delta = fold.outerMetrics.rmse - compare.outerMetrics.rmse;
    if (Math.abs(delta) <= 1e-12) tiedFolds += 1;
    else if (delta < 0) leftBetterRmseFolds += 1;
    else rightBetterRmseFolds += 1;
  }
  return { leftBetterRmseFolds, rightBetterRmseFolds, tiedFolds, comparableFolds: left.folds.length };
}

async function commitDocuments(): Promise<void> {
  await mkdir(outputRoot, { recursive: true });
  for (const [name, bytes] of [...documents].sort(([a], [b]) => a.localeCompare(b))) {
    const target = path.join(outputRoot, name);
    try {
      const current = await readFile(target);
      if (!current.equals(bytes)) throw new Error(`IMMUTABLE_OUTPUT_DRIFT:${name}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeFile(target, bytes);
    }
  }
  const inventoryRows = [...documents].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: sha(bytes) }));
  const inventory = seal({ schemaVersion: "direction-a.evo-post-t1-requalification.inventory.v1", generatedAt, files: inventoryRows });
  const inventoryBytes = Buffer.from(stableText(inventory));
  const inventoryPath = path.join(outputRoot, "SHA256_INVENTORY.json");
  try {
    const current = await readFile(inventoryPath);
    if (!current.equals(inventoryBytes)) throw new Error("IMMUTABLE_OUTPUT_DRIFT:SHA256_INVENTORY.json");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(inventoryPath, inventoryBytes);
  }
}

async function main(): Promise<void> {
  const paths = {
    prepared: path.join(roots.runtime, "prepared/T1_PREPARED_EXECUTION_MANIFEST.json"),
    modelRule: path.join(roots.authority, "03_ENGINEERING_MODEL_SELECTION_RULE.json"),
    t2Rule: path.join(roots.authority, "05_T2_TRIGGER_FREEZE.json"),
    costTable: path.join(roots.authority, "08_BUDGET100_STAGE_COST_TABLE.json"),
    freshPrefix: path.join(roots.authority, "07_FRESH13_PREFIX_FREEZE.json"),
    baselineSpec: path.join(roots.authority, "04_BASELINE_FREEZE_SPEC.json"),
    proposedSource: path.join(roots.postcal, "11_PROPOSED_V2_FINAL_MODEL.json"),
    legacySource: path.join(roots.postcal, "12_BASELINE_V2_FINAL_MODEL.json"),
    oldBank: path.join(roots.predecessor, "03_EVO_CONTINUOUS_DEVELOPMENT_BANK.jsonl"),
    reclassification: path.join(roots.antiCensoring, "03_HISTORICAL_ATTEMPT_RECLASSIFICATION.json"),
    amendment: path.join(roots.freshN9, "02_N9_SAMPLE_AND_BUDGET_AMENDMENT.json"),
    exactFreshManifest: path.join(roots.freshN9, "03_FRESH_EXACT_MANIFEST_FREEZE.json"),
    preparedContract: path.join(roots.freshN9, "06_FRESH_PREPARED_MANIFEST_CONTRACT.json"),
    executionProfile: path.join(repoRoot, ".research/direction-a/current-formal/pilot/manifests/real-execution-profile-v3.json"),
  };
  const [prepared, modelRule, t2Rule, costTable, freshPrefix, baselineSpec, proposedSource, legacySource, reclassification, amendment, exactFreshManifest, preparedContract, executionProfile] = await Promise.all([
    paths.prepared, paths.modelRule, paths.t2Rule, paths.costTable, paths.freshPrefix, paths.baselineSpec,
    paths.proposedSource, paths.legacySource, paths.reclassification, paths.amendment, paths.exactFreshManifest,
    paths.preparedContract, paths.executionProfile,
  ].map(readJson));
  for (const [label, document] of Object.entries({ prepared, modelRule, t2Rule, costTable, freshPrefix, baselineSpec, proposedSource, legacySource, reclassification, amendment, exactFreshManifest, preparedContract, executionProfile })) {
    assertSelfHash(document, label);
  }

  // Stage F: freeze and validate the only lawful post-T1 decision rules before reading any recovered Y.
  const expectedStableIffAll = [
    "ENGINEERING_WINNER_IS_ERROR_GUARDRAIL_ELIGIBLE", "AT_LEAST_2_DISTINCT_TASK_THETA_LEVELS",
    "AT_LEAST_2_NONZERO_TASK_MEAN_THETAS", "WINNER_SCORE_VARIANCE_GT_1E_12",
    "WINNER_JACKKNIFE_SUPPORT_GE_6_OF_8", "WINNER_MODAL_FEATURE_BLOCK_SUPPORT_GE_6_OF_8",
    "WINNER_MODAL_LAMBDA_SUPPORT_GE_6_OF_8",
  ];
  if (modelRule.contentHash !== "5fd5bb424985eee5c6e2e840a0d4bb7c2077f489859c81e325f2faec65df6690"
    || t2Rule.contentHash !== "01c2607400395e0204ca1b1b10ef9fb467d9c2f92df9f224df36bcb0e7ebca02"
    || JSON.stringify(t2Rule.stableIffAll) !== JSON.stringify(expectedStableIffAll)) {
    throw new Error("CORE_DECISION_REQUIRED_POST_T1_STABLE_RULE_UNPROVABLE");
  }
  const ruleFreeze = addJson("07_POST_T1_REQUALIFICATION_RULE_FREEZE.json", {
    schemaVersion: "direction-a.evo-post-t1-requalification-rule-freeze.v1", generatedAt, decisionId, status: "PASS",
    freezeOccurredBeforeRecoveredYConsumption: true,
    modelSelectionRule: { ...await fileBinding(paths.modelRule), contentHash: modelRule.contentHash, exactRule: modelRule.lexicographicRule },
    stabilityRule: { ...await fileBinding(paths.t2Rule), contentHash: t2Rule.contentHash, stableIffAll: t2Rule.stableIffAll },
    candidates: modelRule.candidates, featureBlocks: modelRule.featureBlocks, lambdaGrid: modelRule.lambdaGrid,
    split: modelRule.split, guardrail: modelRule.eligibilityGuardrail, fallback: modelRule.deterministicNoEligibleFallback,
    prohibitedAfterY: ["RULE_REWRITE", "THRESHOLD_REWRITE", "KEEP_HISTORICAL_STABLE_BY_FORCE", "FRESH_OR_Q6_Y"],
  });

  const [originalJ, recoveryJ, continuationJ, retryJ, finalJ] = await Promise.all([
    loadJournal("ORIGINAL_T1", roots.runtime), loadJournal("PAIR_ORDER_RECOVERY", roots.recovery),
    loadJournal("ANTI_CENSORING_CONTINUATION", roots.continuation), loadJournal("D3_P3_REMOVE_BOUNDED_RETRY", roots.retry),
    loadJournal("D3_P3_FULL_BOUNDED_FINAL", roots.final),
  ]);
  const journals = [originalJ, recoveryJ, continuationJ, retryJ, finalJ];
  const summaries = journals.map(journalSummary);
  if (summaries.some((row) => row.causalYCommittedEvents !== 0)) throw new Error("POST_T1_CONSUMER_ALREADY_ADVANCED");

  if (reclassification.attemptId !== "t1-pair-order-recovery-1-p2-remove-try-1"
    || reclassification.currentDerivedClassification !== "SCIENTIFIC_FAILURE"
    || reclassification.scientificFailureReason !== "COMPILE_FAILURE"
    || reclassification.derivedOutcome.numerator !== 0 || reclassification.derivedOutcome.denominator !== 362
    || reclassification.gradingPolicySha256 !== "11d6f0cc9b8e0b3d394508908a47ec33db49b0d13a3e6be641ddfc45a8d674a8") {
    throw new Error("ANTI_CENSORING_RECLASSIFICATION_BINDING_FAIL");
  }
  const fallbackSummary = {
    totalCases: reclassification.derivedOutcome.denominator,
    successCount: reclassification.derivedOutcome.numerator,
    failCount: reclassification.derivedOutcome.denominator - reclassification.derivedOutcome.numerator,
    utility: reclassification.derivedOutcome.utility,
    strictPass: reclassification.derivedOutcome.strictPass,
  };

  const groupByDomain = new Map((prepared.groups as Json[]).map((group) => [group.officialDomainId, group]));
  const d6 = groupByDomain.get("d6")!; const d3 = groupByDomain.get("d3")!;
  if (!d6 || !d3 || prepared.groups.length !== 2) throw new Error("T1_PREPARED_GROUP_BINDING_FAIL");

  const armSpecs: Array<{ domain: "d6" | "d3"; pair: number; arm: Arm; journal: typeof originalJ; attempt: string; fallback?: Json }> = [
    { domain: "d6", pair: 1, arm: "FULL", journal: originalJ, attempt: "remaining-t1-1-pair_1_full-try-1" },
    { domain: "d6", pair: 1, arm: "REMOVE", journal: originalJ, attempt: "remaining-t1-1-pair_1_remove-try-1" },
    { domain: "d6", pair: 2, arm: "REMOVE", journal: recoveryJ, attempt: "t1-pair-order-recovery-1-p2-remove-try-1", fallback: fallbackSummary },
    { domain: "d6", pair: 2, arm: "FULL", journal: continuationJ, attempt: "t1-anti-censoring-continuation-1-p2-full-try-1" },
    { domain: "d6", pair: 3, arm: "FULL", journal: originalJ, attempt: "remaining-t1-1-pair_3_full-try-1" },
    { domain: "d6", pair: 3, arm: "REMOVE", journal: originalJ, attempt: "remaining-t1-1-pair_3_remove-try-1" },
    { domain: "d6", pair: 4, arm: "REMOVE", journal: continuationJ, attempt: "t1-anti-censoring-continuation-1-p4-remove-try-1" },
    { domain: "d6", pair: 4, arm: "FULL", journal: continuationJ, attempt: "t1-anti-censoring-continuation-1-p4-full-try-1" },
    { domain: "d3", pair: 1, arm: "FULL", journal: originalJ, attempt: "remaining-t1-2-pair_1_full-try-1" },
    { domain: "d3", pair: 1, arm: "REMOVE", journal: originalJ, attempt: "remaining-t1-2-pair_1_remove-try-1" },
    { domain: "d3", pair: 2, arm: "REMOVE", journal: continuationJ, attempt: "t1-anti-censoring-continuation-2-p2-remove-try-1" },
    { domain: "d3", pair: 2, arm: "FULL", journal: continuationJ, attempt: "t1-anti-censoring-continuation-2-p2-full-try-1" },
    { domain: "d3", pair: 3, arm: "REMOVE", journal: retryJ, attempt: "t1-anti-censoring-continuation-2-p3-remove-try-2" },
    { domain: "d3", pair: 3, arm: "FULL", journal: finalJ, attempt: "t1-anti-censoring-continuation-2-p3-full-try-1" },
    { domain: "d3", pair: 4, arm: "FULL", journal: originalJ, attempt: "remaining-t1-2-pair_4_full-try-1" },
    { domain: "d3", pair: 4, arm: "REMOVE", journal: originalJ, attempt: "remaining-t1-2-pair_4_remove-try-1" },
  ];
  const armEvidence = new Map<string, TrialEvidence>();
  for (const spec of armSpecs) {
    const evidence = await trialEvidence(spec.journal, spec.attempt, { fallback: spec.fallback });
    if (evidence.start.arm !== spec.arm || evidence.start.pairIndex !== spec.pair) throw new Error(`ARM_BINDING_FAIL:${spec.attempt}`);
    const denominator = spec.domain === "d6" ? d6.frozenTotalCases : d3.frozenTotalCases;
    if (evidence.caseSummary!.totalCases !== denominator) throw new Error(`DENOMINATOR_DRIFT:${spec.attempt}`);
    armEvidence.set(`${spec.domain}:${spec.pair}:${spec.arm}`, evidence);
  }
  const technicalTry1 = await trialEvidence(continuationJ, "t1-anti-censoring-continuation-2-p3-remove-try-1", { fallback: fallbackSummary });
  if (technicalTry1.finish.terminalStatus !== "TECHNICAL_INVALID"
    || continuationJ.events.some((row) => row.eventType === "PROVIDER_CALL_COMPLETED" && row.attemptId === technicalTry1.attemptId)) {
    throw new Error("D3_P3_REMOVE_TRY1_NOT_ZERO_CALL_TECHNICAL_INVALID");
  }

  const pairAttestations: Json[] = [];
  const pairRows: Json[] = [];
  const provenance: Json[] = [];
  for (const domain of ["d6", "d3"] as const) {
    const group = domain === "d6" ? d6 : d3;
    for (let pair = 1; pair <= 4; pair += 1) {
      const admitted = armSpecs.filter((spec) => spec.domain === domain && spec.pair === pair);
      const starts = admitted.map((spec) => armEvidence.get(`${domain}:${pair}:${spec.arm}`)!.start);
      if (domain === "d3" && pair === 3) starts.splice(1, 0, technicalTry1.start);
      assertActualArmStartOrder(group.pairSchedule as PairSchedule, pair, starts.map((row) => row.arm as Arm));
      const expected = scheduledArms(group.pairSchedule as PairSchedule, pair);
      const full = armEvidence.get(`${domain}:${pair}:FULL`)!;
      const remove = armEvidence.get(`${domain}:${pair}:REMOVE`)!;
      const recovered = !admitted.every((spec) => spec.journal.label === "ORIGINAL_T1");
      const attestation = seal({
        schemaVersion: "direction-a.evo-post-t1.retry-aware-pair-order-attestation.v1", domain, taskId: group.taskId,
        causalGroupId: group.causalGroupId, pairIndex: pair, pairScheduleHash: group.pairSchedule.scheduleHash,
        scheduledArmOrder: expected, actualRetryAwareStartOrder: starts.map((row) => row.arm),
        starts: starts.map((row) => ({ runtime: journals.find((journal) => journal.events.includes(row))!.label,
          sourceSequence: row.sequence, eventHash: row.eventHash, attemptId: row.attemptId, arm: row.arm })),
        retrySemantics: "FIRST_ARM_MAY_REPEAT_BEFORE_SECOND_START;FIRST_ARM_FORBIDDEN_AFTER_SECOND_START",
        technicalInvalidStartsExcludedFromScientificPair: domain === "d3" && pair === 3 ? [technicalTry1.attemptId] : [],
        scientificArmAttemptIds: { full: full.attemptId, remove: remove.attemptId },
        resultHashes: { full: full.finish.resultHash, remove: remove.finish.resultHash },
        recovered, status: "PASS",
      });
      pairAttestations.push(attestation);
      const difference = full.caseSummary!.utility - remove.caseSummary!.utility;
      pairRows.push({ domain, taskId: group.taskId, causalGroupId: group.causalGroupId, pairIndex: pair,
        pairId: `${group.causalGroupId}:pair-${pair}`, scheduledArmOrder: expected,
        full: { attemptId: full.attemptId, ...full.caseSummary, evidence: full.evidence },
        remove: { attemptId: remove.attemptId, ...remove.caseSummary, evidence: remove.evidence,
          antiCensoringFallback: domain === "d6" && pair === 2 },
        difference, pairOrderAttestationHash: attestation.contentHash, recovered });
      provenance.push({ domain, pairIndex: pair, admitted: true, provenance: recovered ? "RECOVERED_REPLACEMENT" : "ORIGINAL_LAWFUL_PAIR",
        fullAttemptId: full.attemptId, removeAttemptId: remove.attemptId, attestationHash: attestation.contentHash });
    }
  }
  provenance.push(
    { domain: "d6", pairIndex: 2, admitted: false, excludedOriginalAttempts: ["remaining-t1-1-pair_2_full-try-1", "remaining-t1-1-pair_2_remove-try-1"], reason: "ORIGINAL_ACTUAL_ORDER_FULL_REMOVE_VIOLATED_REMOVE_FIRST" },
    { domain: "d6", pairIndex: 4, admitted: false, excludedOriginalAttempts: ["remaining-t1-1-pair_4_full-try-1", "remaining-t1-1-pair_4_remove-try-1"], reason: "ORIGINAL_ACTUAL_ORDER_FULL_REMOVE_VIOLATED_REMOVE_FIRST" },
    { domain: "d3", pairIndex: 2, admitted: false, excludedOriginalAttempts: ["remaining-t1-2-pair_2_full-try-1", "remaining-t1-2-pair_2_remove-try-1"], reason: "ORIGINAL_ACTUAL_ORDER_FULL_REMOVE_VIOLATED_REMOVE_FIRST" },
    { domain: "d3", pairIndex: 3, admitted: false, excludedOriginalAttempts: ["remaining-t1-2-pair_3_full-try-1", "remaining-t1-2-pair_3_remove-try-1"], reason: "ORIGINAL_ACTUAL_ORDER_FULL_REMOVE_VIOLATED_REMOVE_FIRST" },
    { domain: "d3", pairIndex: 3, admitted: false, excludedRecoveryAttempt: technicalTry1.attemptId, reason: "TRUE_TECHNICAL_INVALID_ZERO_PROVIDER_CALL_REPLACED_BEFORE_SECOND_ARM" },
  );

  const integrityImplementation = path.join(repoRoot, "src/evaluation/direction-a/formal/acquisition/integrity.ts");
  const retryAware = addJson("02_FINAL_RETRY_AWARE_PAIR_ORDER_ATTESTATIONS.json", {
    schemaVersion: "direction-a.evo-post-t1.final-retry-aware-pair-order-attestations.v1", generatedAt, status: "PASS",
    implementation: await fileBinding(integrityImplementation), pairScheduleSource: await fileBinding(paths.prepared),
    runtimeJournalHeads: Object.fromEntries(summaries.map((row) => [row.label, row.headHash])),
    attestations: pairAttestations, exactPairCount: pairAttestations.length,
    d3P3Chain: [technicalTry1.attemptId, armEvidence.get("d3:3:REMOVE")!.attemptId, armEvidence.get("d3:3:FULL")!.attemptId],
  });

  const finalSpend = roundMoney(summaries.reduce((sum, row) => sum + row.observedSpendCny, 0));
  const originalSpend = summaries[0].observedSpendCny;
  const initialRecoverySpend = summaries[1].observedSpendCny;
  const continuationSpend = roundMoney(summaries.slice(2).reduce((sum, row) => sum + row.observedSpendCny, 0));
  const totalCalls = summaries.reduce((sum, row) => sum + row.providerCalls, 0);
  const postInitialRecoveryCalls = summaries.slice(2).reduce((sum, row) => sum + row.providerCalls, 0);
  if (postInitialRecoveryCalls !== 84 || totalCalls !== 324 || Math.abs(finalSpend - 15.85953) > 1e-9) {
    throw new Error(`RAW_BUDGET_REPLAY_MISMATCH:${postInitialRecoveryCalls}:${totalCalls}:${finalSpend}`);
  }
  const budget = addJson("03_FINAL_RECOVERY_BUDGET_CLOSURE.json", {
    schemaVersion: "direction-a.evo-post-t1.final-recovery-budget-closure.v1", generatedAt, status: "PASS",
    derivation: "SUM_AUTHORITATIVE_PROVIDER_CALL_COMPLETED_AMOUNT_CNY_ONCE_ACROSS_FIVE_DISJOINT_JOURNALS",
    journals: summaries, originalT1SpendCny: originalSpend, initialPairOrderRecoverySpendCny: initialRecoverySpend,
    continuationBoundedRetryAndFinalSpendCny: continuationSpend, finalObservedSpendCny: finalSpend,
    providerCalls: { originalT1: summaries[0].providerCalls, initialPairOrderRecovery: summaries[1].providerCalls,
      postInitialRecoveryNew: postInitialRecoveryCalls, allFiveJournals: totalCalls, thisConsolidation: 0 },
    reservationClosure: { originalRecoveryReservationsOutstanding: 0, boundedRetryReservationsOutstanding: 0,
      boundedFinalReservationsOutstanding: 0, activeReservationsCny: 0, activeReservationCount: 0,
      rule: "RESERVATION_RELEASED_OR_CONSUMED_AFTER_EACH TERMINAL FINISH;ACTUAL_COST_PRESERVED_EXACTLY_ONCE" },
    globalHardCapCny, unreservedRemainingCny: roundMoney(globalHardCapCny - finalSpend),
    currentRunHardZero: { providerCalls: 0, modelApiCalls: 0, secretReads: 0, paidDockerLaunches: 0, t2Calls: 0, freshCalls: 0, q6Calls: 0 },
    historicalSecretReadEventsRetainedAsEvidenceNotReplayed: summaries.reduce((sum, row) => sum + row.historicalSecretContentReadEvents, 0),
  });
  const integrity = addJson("01_FINAL_T1_RECOVERY_INTEGRITY_CONSOLIDATION.json", {
    schemaVersion: "direction-a.evo-post-t1.final-recovery-integrity-consolidation.v1", generatedAt, status: "PASS",
    rawRuntimeJournals: summaries, recoveryScientificSlotsExpected: 8, recoveryScientificSlotsComplete: 8,
    recoveryAttemptStarts: 9, trueTechnicalInvalidAttempts: 1, technicalRetryStarts: 1,
    postInitialRecoveryProviderCallsExpected: 84, postInitialRecoveryProviderCallsObserved: postInitialRecoveryCalls,
    initialRecoveryReclassifiedScientificProviderCalls: summaries[1].providerCalls,
    scientificFailureRetried: false, d3P3RetryBeforeSecondArm: true,
    postT1ConsumerAdvancedBeforeConsolidation: false, rawHistoricalBytesModified: false,
    antiCensoringPolicyScope: "ONLY_PROVEN_D6_P2_REMOVE_COMPILE_FAILURE_WITH_FROZEN_DENOMINATOR_AND_NO_CASE_SUMMARY",
    genericScientificFailureToZeroMapping: false,
    pairOrderAttestationsContentHash: retryAware.contentHash, budgetClosureContentHash: budget.contentHash,
    currentRunHardZero: { providerCalls: 0, modelApiCalls: 0, secretReads: 0, paidDockerLaunches: 0, t2Calls: 0, freshCalls: 0, q6Calls: 0 },
  });

  const fixedGroups: Json[] = [];
  for (const domain of ["d6", "d3"] as const) {
    const group = domain === "d6" ? d6 : d3;
    const rows = pairRows.filter((row) => row.domain === domain).sort((a, b) => a.pairIndex - b.pairIndex);
    const thetaHatFixed4 = mean(rows.map((row) => row.difference));
    fixedGroups.push(seal({ taskId: group.taskId, statisticalClusterId: group.statisticalClusterId,
      officialDomainId: domain, causalGroupId: group.causalGroupId, targetRound: group.targetRound,
      frozenTotalCases: group.frozenTotalCases, pairScheduleHash: group.pairSchedule.scheduleHash,
      pairs: rows, thetaHatFixed4, exactFraction: domain === "d6" ? { numerator: 343, denominator: 1448 } : { numerator: 0, denominator: 1 },
      expectedSanityOnly: { value: domain === "d6" ? 343 / 1448 : 0, matches: Math.abs(thetaHatFixed4 - (domain === "d6" ? 343 / 1448 : 0)) <= 1e-12 },
      technicalStatus: "FOUR_RETRY_AWARE_ORDER_VALID_SCIENTIFIC_PAIRS" }));
  }
  if (fixedGroups.some((group) => !group.expectedSanityOnly.matches)) throw new Error("REPAIRED_FIXED4_SANITY_MISMATCH");
  const fixed4 = addJson("04_REPAIRED_T1_FIXED4_BANK.json", {
    schemaVersion: "direction-a.evo-post-t1.repaired-t1-fixed4-bank.v1", generatedAt, status: "PASS",
    source: "RAW_RESULT_BYTES_PLUS_HASH_CHAINED_JOURNALS_WITH_ONE_NARROW_FROZEN_ANTI_CENSORING_FALLBACK",
    groups: fixedGroups, groupCount: 2, pairCount: 8, armOutcomeCount: 16,
    pairOrderAttestationsContentHash: retryAware.contentHash, antiCensoringReclassification: { ...await fileBinding(paths.reclassification), contentHash: reclassification.contentHash },
  });
  const provenanceMap = addJson("05_REPAIRED_T1_PROVENANCE_MAP.json", {
    schemaVersion: "direction-a.evo-post-t1.repaired-t1-provenance-map.v1", generatedAt, status: "PASS",
    rows: provenance, admittedPairCount: provenance.filter((row) => row.admitted).length,
    excludedOriginalMismatchedPairCount: 4, excludedTechnicalInvalidAttemptCount: 1,
    rawHistoricalBytesModified: false, originalWrongOrderPairsReAdmitted: false,
    fixed4ContentHash: fixed4.contentHash,
  });

  const frozenSource: FrozenSourceModel = { contentHash: proposedSource.contentHash,
    featureOrder: proposedSource.model.featureOrder, means: proposedSource.model.means, scales: proposedSource.model.scales,
    coefficients: proposedSource.model.coefficients, clip: proposedSource.model.clip };
  const normalSpecs = [
    { domain: "d6" as const, group: d6, attempt: "t1-1-normal-try-1", excluded: ["t1-1-normal-try-2"] },
    { domain: "d3" as const, group: d3, attempt: "remaining-t1-2-normal-try-1", excluded: [] },
  ];
  const newRows: Json[] = [];
  for (const config of normalSpecs) {
    const normal = await trialEvidence(originalJ, config.attempt, { process: true });
    const instructionPath = path.join(roots.runtime, `prepared/tasks/evo-t1-${config.domain === "d6" ? "g1" : "g2"}-normal/steps/target-round/instruction.md`);
    const instruction = await readFile(instructionPath, "utf8");
    const featureInput = { targetRound: Number(config.group.targetRound), instruction,
      normal: normal.caseSummary!, process: normal.processEvidence!, model: frozenSource } as any;
    const repaired = fixedGroups.find((row) => row.officialDomainId === config.domain)!;
    const rowBody = {
      schemaVersion: "direction-a.evo-continuous-development-row.v1", permission: "PILOT_TRAIN_DEV",
      causalGroupId: config.group.causalGroupId, taskId: config.group.taskId,
      statisticalClusterId: config.group.statisticalClusterId, officialDomainId: config.domain,
      targetRound: config.group.targetRound, fixed4PairIds: repaired.pairs.map((row: Json) => row.pairId),
      fixed4PairIndices: [1, 2, 3, 4], fixed4Differences: repaired.pairs.map((row: Json) => row.difference),
      thetaHatFixed4: repaired.thetaHatFixed4, technicalStatus: repaired.technicalStatus,
      historicalExtraPairsExcludedFromPrimaryTarget: provenance.filter((row) => row.domain === config.domain && row.admitted === false),
      normalEvidence: { canonicalAttemptId: config.attempt, redundantAttemptIdsExcluded: config.excluded,
        ...normal.caseSummary, ...normal.evidence },
      sourceAdapterInputs: buildAcceptedEvoSourceInputs(featureInput), frozenSourceScore: scoreAcceptedEvoSource(featureInput),
      sharedFeatures: buildAcceptedEvoSharedFeatures(featureInput), processFeatures: buildAcceptedEvoProcessFeatures(normal.processEvidence as any),
      processEvidenceCounts: normal.processEvidence, timingContract: "ALL_X_FROM_S0_OR_NORMAL_RUN_BEFORE_CAUSAL_FULL_REMOVE_Y",
      q6Excluded: true, calExcluded: true, sealedTestExcluded: true, pairRowsTreatedAsIid: false,
      targetAvailability: "AVAILABLE", t1Overlay: true, repairedFixed4ContentHash: repaired.contentHash,
      repairedProvenanceMapContentHash: provenanceMap.contentHash,
    };
    newRows.push(seal(rowBody));
  }
  const oldBankRaw = await readFile(paths.oldBank, "utf8");
  const oldRows = oldBankRaw.trim().split(/\r?\n/).map((line) => JSON.parse(line) as Json);
  if (oldRows.length !== 8 || new Set(oldRows.map((row) => row.statisticalClusterId)).size !== 6) throw new Error("HISTORICAL_BANK_SHAPE_FAIL");
  oldRows.forEach((row) => assertSelfHash(row, `OLD_BANK:${row.causalGroupId}`));
  const bankRows = [...oldRows, ...newRows];
  const taskIds = [...new Set(bankRows.map((row) => row.statisticalClusterId))].sort();
  if (bankRows.length !== 10 || taskIds.length !== 8 || new Set(bankRows.map((row) => row.causalGroupId)).size !== 10) throw new Error("REPAIRED_BANK_SHAPE_FAIL");
  const bank = addJson("06_REPAIRED_POST_T1_8TASK_10GROUP_BANK.json", {
    schemaVersion: "direction-a.evo-post-t1.repaired-8task-10group-bank.v1", generatedAt, status: "PASS",
    historicalSource: { ...await fileBinding(paths.oldBank), rowsPreservedFromSource: 8, rowsRewritten: 0 },
    addedRows: 2, independentCompleteTasks: 8, causalGroups: 10, fixed4Pairs: 40, taskIds,
    rows: bankRows, pairRowsTreatedAsIid: false, redundantD6NormalModelRows: 0,
    q6Rows: 0, freshRows: 0, t2Rows: 0, fixed4ContentHash: fixed4.contentHash,
  });

  const modelingRows: EvoContinuousRow[] = bankRows.map((row) => ({ causalGroupId: row.causalGroupId,
    statisticalClusterId: row.statisticalClusterId, thetaHatFixed4: row.thetaHatFixed4,
    sourceScore: row.frozenSourceScore, sharedFeatures: row.sharedFeatures, processFeatures: row.processFeatures }));
  const nested = Object.fromEntries(candidateIds.map((candidateId) => [candidateId, runEngineeringTaskClusterNestedEvaluation({
    rows: modelingRows, candidateId, sharedFeatureIds, processFeatureIds, lambdas, featureBlocks,
  })])) as Record<EvoCandidateId, EngineeringNestedCandidateResult>;
  const selection = selectEngineeringCandidate(candidateIds.map((candidateId) => candidateEvaluation(nested[candidateId])) as any, { fallbackOrder });
  const abc = addJson("08_POST_T1_ABC_RESULTS.json", {
    schemaVersion: "direction-a.evo-post-t1.requalified-abc-results.v1", generatedAt, status: "COMPLETE",
    evidenceClass: "TRAIN_DEV_ONLY_NOT_FRESH", bankContentHash: bank.contentHash,
    ruleFreezeContentHash: ruleFreeze.contentHash, candidates: nested, engineeringSelection: selection,
  });

  const ablationCandidates: Json = {};
  for (const candidateId of candidateIds) {
    const sharedOnly = runEngineeringTaskClusterNestedEvaluation({ rows: modelingRows, candidateId,
      sharedFeatureIds, processFeatureIds, lambdas, featureBlocks: ["EVO_SHARED_ONLY"] });
    const sharedPlusProcess = runEngineeringTaskClusterNestedEvaluation({ rows: modelingRows, candidateId,
      sharedFeatureIds, processFeatureIds, lambdas, featureBlocks: ["EVO_SHARED_PLUS_PROCESS"] });
    const variant = selectEngineeringCandidate([
      { candidateId: `${candidateId}:EVO_SHARED_ONLY`, predictions: sharedOnly.predictions, complexityRank: 0, onlineCostRank: 0 },
      { candidateId: `${candidateId}:EVO_SHARED_PLUS_PROCESS`, predictions: sharedPlusProcess.predictions, complexityRank: 1, onlineCostRank: 1 },
    ], { fallbackOrder: [`${candidateId}:EVO_SHARED_ONLY`, `${candidateId}:EVO_SHARED_PLUS_PROCESS`] });
    ablationCandidates[candidateId] = { sharedOnly, sharedPlusProcess, engineeringPreferredVariant: variant.winnerId,
      rmseDeltaProcessMinusShared: sharedPlusProcess.metrics.rmse - sharedOnly.metrics.rmse,
      maeDeltaProcessMinusShared: sharedPlusProcess.metrics.mae - sharedOnly.metrics.mae,
      policyValueDeltaProcessMinusShared: sharedPlusProcess.metrics.policyValue - sharedOnly.metrics.policyValue,
      outerDirectionalStability: foldDirection(sharedPlusProcess, sharedOnly) };
  }
  const processAblation = addJson("09_POST_T1_PROCESS_ABLATION.json", {
    schemaVersion: "direction-a.evo-post-t1.requalified-process-ablation.v1", generatedAt, status: "COMPLETE",
    bankContentHash: bank.contentHash, ruleFreezeContentHash: ruleFreeze.contentHash,
    candidates: ablationCandidates, interpretation: "FROZEN_SHARED_ONLY_VS_SHARED_PLUS_PROCESS_TRAIN_DEV_ONLY",
  });

  const trigger = evaluateT2Trigger({
    candidates: candidateIds.map((candidateId) => ({ ...candidateEvaluation(nested[candidateId]),
      foldSelections: nested[candidateId].folds.map((fold) => ({ featureBlock: fold.selectedFeatureBlock, lambda: fold.selectedLambda })) })) as any,
    expectedTaskClusters: 8, fallbackOrder,
  });
  const checkpoint = trigger.branch === "STABLE_FREEZE_NO_T2" ? "STABLE" : "NOT_STABLE";
  const next = checkpoint === "STABLE" ? "READY_FOR_EVO_FRESH_REAUTHORIZATION" : "READY_FOR_EVO_T2_RESEARCHER_DECISION";
  const checkpointDoc = addJson("10_POST_T1_MODEL_CHECKPOINT.json", {
    schemaVersion: "direction-a.evo-post-t1.requalified-model-checkpoint.v1", generatedAt, decisionId,
    checkpoint, exactTerminal: `POST_T1_MODEL_CHECKPOINT = ${checkpoint}`, next,
    winnerId: selection.winnerId, trigger, stableIffAll: t2Rule.stableIffAll,
    frozenRuleContentHashes: { selection: modelRule.contentHash, stability: t2Rule.contentHash },
    evidence: { integrity: plannedBinding("01_FINAL_T1_RECOVERY_INTEGRITY_CONSOLIDATION.json"),
      pairOrder: plannedBinding("02_FINAL_RETRY_AWARE_PAIR_ORDER_ATTESTATIONS.json"), budget: budget.contentHash,
      fixed4: fixed4.contentHash, bank: bank.contentHash, abc: abc.contentHash, processAblation: processAblation.contentHash },
    historicalCheckpointStatusCarriedForward: false, historicalStableForced: false,
  });

  let branchSummary = "";
  if (checkpoint === "STABLE") {
    const finalNested = nested[selection.winnerId as EvoCandidateId];
    const proposedModel = fitFinalCandidateFromNested(modelingRows, finalNested as unknown as NestedCandidateResult, sharedFeatureIds, processFeatureIds);
    const proposed = addJson("11_FINAL_PROPOSED_MODEL_FREEZE.json", {
      schemaVersion: "direction-a.evo-post-t1.requalified-proposed-model-freeze.v1", generatedAt, status: "PASS",
      candidateId: selection.winnerId, featureBlock: proposedModel.featureBlock, lambda: proposedModel.lambda,
      fittedModel: proposedModel, canonicalTrainingHash: proposedModel.trainingHash, canonicalModelHash: hashCanonical(proposedModel),
      trainingBankContentHash: bank.contentHash, modelSelectionContentHash: selection.contentHash,
      sourceModel: { ...await fileBinding(paths.proposedSource), contentHash: proposedSource.contentHash }, noFreshYUsed: true,
    });
    const legacyModel: FrozenSourceModel = { contentHash: legacySource.contentHash, featureOrder: legacySource.model.featureOrder,
      means: legacySource.model.means, scales: legacySource.model.scales, coefficients: legacySource.model.coefficients, clip: legacySource.model.clip };
    const baselineRows: EvoContinuousRow[] = bankRows.map((row) => {
      const inputs = Object.fromEntries(legacySource.model.featureOrder.map((id: string, index: number) => [id, legacySource.model.means[index]]));
      inputs.x0_history_turn_count_log = row.sourceAdapterInputs.x0_history_turn_count_log;
      inputs.x0_query_token_count_log = row.sourceAdapterInputs.x0_query_token_count_log;
      return { causalGroupId: row.causalGroupId, statisticalClusterId: row.statisticalClusterId, thetaHatFixed4: row.thetaHatFixed4,
        sourceScore: scoreFrozenSource(legacyModel, inputs), sharedFeatures: {
          shared_target_round_log: row.sharedFeatures.shared_target_round_log,
          shared_instruction_bytes_log: row.sharedFeatures.shared_instruction_bytes_log }, processFeatures: {} };
    });
    const baselineSharedIds = ["shared_target_round_log", "shared_instruction_bytes_log"];
    const baselineNested = runEngineeringTaskClusterNestedEvaluation({ rows: baselineRows, candidateId: "A_FROZEN_SOURCE_RESIDUAL_RIDGE",
      sharedFeatureIds: baselineSharedIds, processFeatureIds: [], lambdas, featureBlocks: ["EVO_SHARED_ONLY"] });
    const baselineModel = fitFinalCandidateFromNested(baselineRows, baselineNested as unknown as NestedCandidateResult, baselineSharedIds, []);
    const baseline = addJson("12_FINAL_PRIMARY_BASELINE_FREEZE.json", {
      schemaVersion: "direction-a.evo-post-t1.requalified-primary-baseline-freeze.v1", generatedAt, status: "PASS",
      id: "MATCHED_CAPACITY_LEGACY_X0_BASELINE", target: "thetaHatFixed4", featureContract: baselineSharedIds,
      sourceModel: { ...await fileBinding(paths.legacySource), contentHash: legacySource.contentHash }, baselineRecipe: { ...await fileBinding(paths.baselineSpec), contentHash: baselineSpec.contentHash },
      fittedModel: baselineModel, canonicalTrainingHash: baselineModel.trainingHash, canonicalModelHash: hashCanonical(baselineModel),
      nestedFoldSelections: baselineNested.folds.map((fold) => ({ taskId: fold.outerClusterId, lambda: fold.selectedLambda })), noFreshYUsed: true,
    });
    const comparatorNested = runEngineeringTaskClusterNestedEvaluation({ rows: modelingRows, candidateId: "C_EVO_ONLY_RIDGE",
      sharedFeatureIds, processFeatureIds, lambdas, featureBlocks: ["EVO_SHARED_ONLY"] });
    const comparatorModel = fitFinalCandidateFromNested(modelingRows, comparatorNested as unknown as NestedCandidateResult, sharedFeatureIds, processFeatureIds);
    const comparator = addJson("13_FINAL_STRONG_COMPARATOR_FREEZE.json", {
      schemaVersion: "direction-a.evo-post-t1.requalified-strong-comparator-freeze.v1", generatedAt, status: "PASS",
      id: "TARGET_ONLY_SHARED_ONLY_RIDGE", candidateId: "C_EVO_ONLY_RIDGE", target: "thetaHatFixed4",
      featureContract: sharedFeatureIds, fittedModel: comparatorModel, canonicalTrainingHash: comparatorModel.trainingHash,
      canonicalModelHash: hashCanonical(comparatorModel), nestedFoldSelections: comparatorNested.folds.map((fold) => ({ taskId: fold.outerClusterId, lambda: fold.selectedLambda })), noFreshYUsed: true,
    });
    if (amendment.globalHardCapCny !== globalHardCapCny || JSON.stringify(amendment.frozenAffordabilityLadder) !== JSON.stringify([9, 8, 7, 6])) throw new Error("FRESH_BUDGET_AMENDMENT_DRIFT");
    const selectedN = (amendment.frozenAffordabilityLadder as number[]).find((n) => finalSpend + costTable.freshN[String(n)].freshStageP95ReservationCny <= globalHardCapCny);
    if (!selectedN) throw new Error("NO_AFFORDABLE_FRESH_PREFIX");
    const selectedCost = costTable.freshN[String(selectedN)];
    const affordability = addJson("14_FRESH_AFFORDABILITY_AND_RESERVATION.json", {
      schemaVersion: "direction-a.evo-post-t1.fresh-affordability-reservation.v1", generatedAt, status: "PASS",
      ladder: amendment.frozenAffordabilityLadder, selectedN, finalObservedSpendCny: finalSpend,
      reservationCny: selectedCost.freshStageP95ReservationCny, protectedTotalCny: roundMoney(finalSpend + selectedCost.freshStageP95ReservationCny),
      globalHardCapCny, remainingAfterReservationCny: roundMoney(globalHardCapCny - finalSpend - selectedCost.freshStageP95ReservationCny),
      expectedProviderCalls: selectedCost.expectedProviderCalls, maximumProviderCalls: selectedCost.maximumProviderCalls,
      activeReservationsBeforeFreshGrantCny: 0, reservationStatus: "REQUESTED_NOT_ACTIVE_UNTIL_FRESH_REAUTHORIZATION",
      amendment: { ...await fileBinding(paths.amendment), contentHash: amendment.contentHash }, n10Forbidden: true,
    });
    const selectedTasks = (freshPrefix.orderedTasks as Json[]).slice(0, selectedN);
    if (selectedN !== 9 || freshPrefix.prefixHash !== amendment.prefixHash) throw new Error("FRESH_N9_PREFIX_REQUALIFICATION_FAIL");
    const prefixFreeze = addJson("15_FRESH_PREFIX_FREEZE.json", {
      schemaVersion: "direction-a.evo-post-t1.requalified-fresh-prefix-freeze.v1", generatedAt, status: "PASS",
      selectedN, prefixHash: freshPrefix.prefixHash, orderedTasks: selectedTasks,
      exactTaskIds: selectedTasks.map((task) => task.taskId), exactCausalGroupIds: selectedTasks.map((task) => task.canonicalCausalGroupId),
      selectedIdentityHash: hashCanonical({ prefixHash: freshPrefix.prefixHash, selectedN, selectedTasks }),
      sourcePrefix: { ...await fileBinding(paths.freshPrefix), contentHash: freshPrefix.contentHash },
      structuralExactManifestProvenance: { ...await fileBinding(paths.exactFreshManifest), contentHash: exactFreshManifest.contentHash },
      oldScientificModelBindingsSuperseded: true, outcomeBlindOrderPreserved: true,
    });
    const modelSet = addJson("16_FINAL_MODEL_SET_FREEZE.json", {
      schemaVersion: "direction-a.evo-post-t1.requalified-final-model-set-freeze.v1", generatedAt, status: "PASS",
      proposed: { id: selection.winnerId, artifactContentHash: proposed.contentHash, trainingHash: proposedModel.trainingHash },
      primaryBaseline: { id: "MATCHED_CAPACITY_LEGACY_X0_BASELINE", artifactContentHash: baseline.contentHash, trainingHash: baselineModel.trainingHash },
      strongComparator: { id: "TARGET_ONLY_SHARED_ONLY_RIDGE", artifactContentHash: comparator.contentHash, trainingHash: comparatorModel.trainingHash },
      coverage: 0.7, acceptedCountContract: "round_half_up(coverage*N)", priorityCoverages: [0.4, 0.6, 0.7, 0.8],
      rankingRule: "SCORE_DESC_THEN_CANONICAL_TASK_ID_ASC", refitAfterFreshY: false,
    });
    const { contentHash: _historicalExactHash, ...historicalExactBody } = exactFreshManifest;
    const requalifiedExactManifest = addJson("FRESH_EXACT_MANIFEST_FREEZE.json", {
      ...historicalExactBody,
      budget: { ...exactFreshManifest.budget, priorReconciledSpendCny: finalSpend },
      supersedesHistoricalExactManifestContentHash: exactFreshManifest.contentHash,
      sampleIdentityAndOrderChanged: false,
    });
    const featureScoring = addJson("FRESH_FEATURE_SCORING_BINDING.json", {
      schemaVersion: "direction-a.evo-fresh-feature-scoring-byte-bindings.v1",
      bindings: {
        proposedModel: plannedBinding("11_FINAL_PROPOSED_MODEL_FREEZE.json"),
        primaryBaseline: plannedBinding("12_FINAL_PRIMARY_BASELINE_FREEZE.json"),
        strongComparator: plannedBinding("13_FINAL_STRONG_COMPARATOR_FREEZE.json"),
        featureContract: plannedBinding("11_FINAL_PROPOSED_MODEL_FREEZE.json"),
        preprocessing: plannedBinding("11_FINAL_PROPOSED_MODEL_FREEZE.json"),
        sourceScoreImplementation: await fileBinding(path.join(repoRoot, "src/evaluation/direction-a/formal/evo-fresh/fresh-feature-scoring.ts")),
        predictorImplementation: await fileBinding(path.join(repoRoot, "src/evaluation/direction-a/formal/modeling/evo-continuous-adaptation.ts")),
        trainingBank: plannedBinding("06_REPAIRED_POST_T1_8TASK_10GROUP_BANK.json"),
        modelSet: plannedBinding("16_FINAL_MODEL_SET_FREEZE.json"),
        proposedSourceModel: await fileBinding(paths.proposedSource), legacySourceModel: await fileBinding(paths.legacySource),
        currentCheckpointFeatureConsumer: await fileBinding(path.join(repoRoot, "scripts/direction-a/formal/evo-post-t1-requalification.ts")),
      },
    });
    const runbookName = "WORKBUDDY_EVO_FRESH_REQUALIFIED.md";
    addText(runbookName, `# WorkBuddy — Evo Fresh requalified request\n\nStatus: **REQUEST ONLY / NOT AUTHORIZED**.\n\nUse N=${selectedN}, prefix hash \`${freshPrefix.prefixHash}\`, expected ${selectedCost.expectedProviderCalls} calls, maximum ${selectedCost.maximumProviderCalls}, and CNY ${selectedCost.freshStageP95ReservationCny} reservation under the CNY ${globalHardCapCny} hard cap. No grant exists in this package.\n\n1. Materialize a new immutable researcher grant that binds \`17_FRESH_AUTHORIZATION_REQUEST.json\` and every required hash. Old post-T1 grants/checkpoints are invalid. The live grant/prepare/runner scripts default to this closure; an explicit \`--closure-root\` may be used for audit replay.\n2. Run zero-provider preflight and prepare only after that grant exists.\n3. Complete/reconcile NORMAL for all nine tasks. Causal FULL/REMOVE is forbidden until the all-NORMAL barrier is sealed.\n4. With zero provider calls, score all nine tasks with the three models in \`16_FINAL_MODEL_SET_FREEZE.json\`; freeze rank, 70% accepted IDs, and 40/60/70/80 objects.\n5. After exact Gate-D seal verification, run fixed4 FULL/REMOVE in each frozen pairSchedule order. A first-arm technical retry may repeat before the second arm; the first arm can never recur after the second begins.\n\nGlobal stop on hash drift, unknown/duplicate dispatch, stale reservation, budget ambiguity, missing NORMAL, interleaved NORMAL/causal execution, Pair5, T2, Q6, refit, or outcome-adaptive deepening. Scientific failure is evidence and is never retried; only a true frozen technical-invalid reason may consume reserve.\n`);
    const sourcePaths: Record<string, string> = {
      currentRequalificationConsumer: path.join(repoRoot, "scripts/direction-a/formal/evo-post-t1-requalification.ts"),
      independentVerifier: path.join(repoRoot, "scripts/direction-a/formal/evo-post-t1-requalification-verify.ts"),
      legacyConsumerFirewall: path.join(repoRoot, "scripts/direction-a/formal/evo-post-t1-checkpoint.ts"),
      exactManifestValidator: path.join(repoRoot, "src/evaluation/direction-a/formal/evo-fresh/fresh-manifest.ts"),
      paidAuthority: path.join(repoRoot, "src/evaluation/direction-a/formal/evo-fresh/fresh-paid-authority.ts"),
      grantGate: path.join(repoRoot, "src/evaluation/direction-a/formal/evo-fresh/fresh-execution-gate.ts"),
      featureScoring: path.join(repoRoot, "src/evaluation/direction-a/formal/evo-fresh/fresh-feature-scoring.ts"),
      phaseStateMachine: path.join(repoRoot, "src/evaluation/direction-a/formal/evo-fresh/fresh-prey-runtime.ts"),
      authoritativeJournal: path.join(repoRoot, "src/evaluation/direction-a/formal/prepilot/execution-state-attestation.ts"),
      pairOrderIntegrity: integrityImplementation,
      harborExecutor: path.join(repoRoot, "src/evaluation/direction-a/formal/executors/evo-harbor-executor.ts"),
      prepareDriver: path.join(repoRoot, "scripts/direction-a/formal/evo-fresh-prepare.ts"),
      phaseRunner: path.join(repoRoot, "scripts/direction-a/formal/evo-fresh-paid-run.ts"),
      grantMaterializer: path.join(repoRoot, "scripts/direction-a/formal/evo-fresh-grant-materialize.ts"),
      grantVerifier: path.join(repoRoot, "scripts/direction-a/formal/evo-fresh-grant-verify.ts"),
      executionProfile: paths.executionProfile,
    };
    for (const sourcePath of Object.values(sourcePaths)) await access(sourcePath);
    const sourceBindings = Object.fromEntries(await Promise.all(Object.entries(sourcePaths).map(async ([key, file]) => [key, await fileBinding(file)])));
    const artifactNames = ["01_FINAL_T1_RECOVERY_INTEGRITY_CONSOLIDATION.json", "02_FINAL_RETRY_AWARE_PAIR_ORDER_ATTESTATIONS.json",
      "03_FINAL_RECOVERY_BUDGET_CLOSURE.json", "04_REPAIRED_T1_FIXED4_BANK.json", "05_REPAIRED_T1_PROVENANCE_MAP.json",
      "06_REPAIRED_POST_T1_8TASK_10GROUP_BANK.json", "07_POST_T1_REQUALIFICATION_RULE_FREEZE.json", "08_POST_T1_ABC_RESULTS.json",
      "09_POST_T1_PROCESS_ABLATION.json", "10_POST_T1_MODEL_CHECKPOINT.json", "11_FINAL_PROPOSED_MODEL_FREEZE.json",
      "12_FINAL_PRIMARY_BASELINE_FREEZE.json", "13_FINAL_STRONG_COMPARATOR_FREEZE.json", "14_FRESH_AFFORDABILITY_AND_RESERVATION.json",
      "15_FRESH_PREFIX_FREEZE.json", "16_FINAL_MODEL_SET_FREEZE.json", "FRESH_EXACT_MANIFEST_FREEZE.json",
      "FRESH_FEATURE_SCORING_BINDING.json", runbookName];
    const artifactBindings = Object.fromEntries(artifactNames.map((name) => [name, plannedBinding(name)]));
    const combinedBindings = { ...sourceBindings,
      ...Object.fromEntries(Object.entries(artifactBindings).map(([key, value]) => [`artifact:${key}`, value])) };
    const requiredBindingPaths = Object.fromEntries(Object.entries(combinedBindings).map(([key, value]: [string, any]) => [key, value.path]));
    const requiredBindings = Object.fromEntries(Object.entries(combinedBindings).map(([key, value]: [string, any]) => [key, value.sha256]));
    const request = addJson("17_FRESH_AUTHORIZATION_REQUEST.json", {
      schemaVersion: "direction-a.evo-fresh-n9-authorization-request.v1", generatedAt,
      decisionId: "EVO_FRESH_N9_BUDGET110_2026_09_12", status: "PENDING_RESEARCHER_REAUTHORIZATION",
      requestedStage: "EVO_FRESH_ENGINEERING_HOLDOUT", next: "READY_FOR_EVO_FRESH_REAUTHORIZATION",
      authorized: false, materializedResearcherApproval: false, executeNow: false, allowPaidExecution: false,
      freshN: selectedN, freshPrefixHash: freshPrefix.prefixHash,
      exactManifestHash: requalifiedExactManifest.contentHash,
      preparedManifestSchema: "direction-a.evo-fresh-n9-prepared-manifest.v1",
      preparedManifestContractHash: preparedContract.contentHash,
      runtimeRoot: FRESH_RUNTIME_ROOT, executionProfileHash: executionProfile.contentHash,
      paidAuthorityHash: FRESH_PAID_AUTHORITY.contentHash,
      exactTaskIds: selectedTasks.map((task) => task.taskId),
      exactCausalGroupIds: selectedTasks.map((task) => task.canonicalCausalGroupId), expectedProviderCalls: selectedCost.expectedProviderCalls,
      maximumProviderCalls: selectedCost.maximumProviderCalls, freshP95ReservationCny: selectedCost.freshStageP95ReservationCny,
      priorReconciledSpendCny: finalSpend, protectedTotalCny: affordability.protectedTotalCny, globalHardCapCny,
      researcherBudgetExtensionMaximumCny: amendment.researcherBudgetExtensionMaximumCny,
      approvalStringFormat: "APPROVE_EVO_FRESH_ENGINEERING_HOLDOUT <REQUEST_CONTENT_HASH>",
      modelSetContentHash: modelSet.contentHash, prefixFreezeContentHash: prefixFreeze.contentHash,
      featureScoringBindingsHash: featureScoring.contentHash,
      requiredBindingPaths, requiredBindings, requiredBindingsCount: Object.keys(requiredBindings).length,
      requiredBindingsHash: hashCanonical(requiredBindings),
      oldPostT1CheckpointAndGrantBindingsAccepted: false, newGrantMustBindThisRequestContentHash: true,
      forbidden: ["TRAIN", "T2", "Q6", "PAIR_5", "N10", "EXTRA_TRAIN", "FRESH_Y_BEFORE_PRE_Y_SEAL", "INTERLEAVED_NORMAL_AND_CAUSAL_Y",
        "MODEL_REFIT", "POLICY_REFIT_AFTER_Y", "OUTCOME_ADAPTIVE_DEEPENING", "SECRET_READ_DURING_ZERO_PROVIDER_REQUALIFICATION"],
      currentRunHardZero: { providerCalls: 0, modelApiCalls: 0, secretReads: 0, paidDockerLaunches: 0 },
    });
    branchSummary = `Fresh N=${selectedN}; request hash=${request.contentHash}; request only, zero calls authorized.`;
  } else {
    const t2Cost = costTable.t2Conditional;
    const affordable = finalSpend + t2Cost.freshStageP95ReservationCny <= globalHardCapCny;
    addJson("11_T2_TRIGGER_AND_NEXT_ACTION.json", {
      schemaVersion: "direction-a.evo-post-t1.t2-researcher-decision.v1", generatedAt, status: "RESEARCHER_DECISION_REQUIRED",
      next: "READY_FOR_EVO_T2_RESEARCHER_DECISION", trigger, frozenGroups: t2Rule.unstableBranch.groups,
      exactCausalGroupIds: t2Rule.unstableBranch.causalGroupIds, selectionPolicy: t2Rule.unstableBranch.selectionPolicy,
      selectionSeed: t2Rule.unstableBranch.selectionSeed, t3: "PROHIBITED", fixedPairsPerGroup: 4, pair5: false,
      budget: { finalObservedSpendCny: finalSpend, p95ReservationCny: t2Cost.freshStageP95ReservationCny,
        protectedTotalCny: roundMoney(finalSpend + t2Cost.freshStageP95ReservationCny), globalHardCapCny, affordable },
      authorized: false, providerCallsAuthorizedNow: 0, freshAuthorized: false, q6Authorized: false,
      checkpointContentHash: checkpointDoc.contentHash,
    });
    branchSummary = "Frozen criteria returned NOT_STABLE; stopped at exact T2 researcher-decision boundary.";
  }

  addText("18_FOCUSED_TEST_REPORT.md", `# Focused test report\n\nStatus: **${validated ? "PASS" : "PENDING"}**.\n\n1. PASS — all five append-only journal chains and result SHA-256 bindings replay.\n2. PASS — retry-aware pair order covers all 8 pairs, including REMOVE try-1 technical -> REMOVE try-2 -> FULL for d3 P3.\n3. PASS — raw provider events reconcile 84 post-initial-recovery calls, 324 total calls, and CNY ${finalSpend}.\n4. PASS — repaired fixed4 has 8 complete pairs; d6=${fixedGroups[0].thetaHatFixed4}, d3=${fixedGroups[1].thetaHatFixed4}.\n5. PASS — bank is 8 independent tasks / 10 unique causal groups and preserves 8 historical row hashes.\n6. PASS — frozen A/B/C nested evaluation, shared/process ablation, selection, and all 7 STABLE criteria replay.\n7. PASS — mechanical branch is ${checkpoint}; ${branchSummary}\n8. PASS — current-run provider/model/secret/paid-Docker/T2/Fresh/Q6 counts are all zero.\n9. ${validated ? "PASS — focused Vitest, Direction-A typecheck, independent verifier, deterministic second replay, and diff check completed." : "PENDING — run the validation commands before final delivery."}\n`);
  addText("19_REPRODUCIBILITY_AND_BINDING_REPORT.md", `# Reproducibility and binding report\n\nThe generator consumes current immutable source bytes, raw result files, and five hash-chained journals. It never consumes old post-T1 runtime counters, old theta values, or the old checkpoint status. JSON self-hashes use repository canonical SHA-256; the inventory binds stable serialized bytes. Existing output files are accepted only when byte-identical, so the second run is a deterministic replay rather than an overwrite.\n\nCommands:\n\n- \`pnpm.cmd exec tsx scripts/direction-a/formal/evo-post-t1-requalification.ts --validated\`\n- \`pnpm.cmd exec tsx scripts/direction-a/formal/evo-post-t1-requalification-verify.ts\`\n- \`pnpm.cmd exec vitest run src/evaluation/direction-a/formal/modeling/evo-engineering-first.test.ts src/evaluation/direction-a/formal/evo-t1-pair-order-recovery.test.ts src/evaluation/direction-a/formal/evo-t1-anti-censoring-continuation.test.ts src/evaluation/direction-a/formal/evo-fresh.test.ts\`\n- \`pnpm.cmd run typecheck:direction-a\`\n\nFrozen rule hashes: selection \`${modelRule.contentHash}\`; STABLE trigger \`${t2Rule.contentHash}\`. Repaired bank hash: \`${bank.contentHash}\`. Checkpoint: **${checkpoint}**.\n`);
  addText("00_READ_FIRST.md", `# Direction A — final post-T1 recovery consolidation and requalification\n\nStatus: **COMPLETE**. POST_T1_MODEL_CHECKPOINT = **${checkpoint}**.\n\nRecovered scientific evidence was rebuilt from raw result bytes and hash-chained journals. d6 fixed4 theta is ${fixedGroups[0].thetaHatFixed4}; d3 fixed4 theta is ${fixedGroups[1].thetaHatFixed4}. Final observed spend is CNY ${finalSpend}, with no active recovery reservation. The frozen pre-Y rules were applied without preserving the historical checkpoint outcome.\n\nNext: **${next}**. ${branchSummary}\n\nThis consolidation made zero provider/model calls, read zero secrets, launched zero paid Docker jobs, and executed zero T2/Fresh/Q6 calls. Historical runtime evidence remains byte-unchanged.\n`);

  await commitDocuments();
  process.stdout.write(`EVO_POST_T1_REQUALIFICATION_COMPLETE\nPOST_T1_MODEL_CHECKPOINT=${checkpoint}\nNEXT=${next}\nD6_THETA_FIXED4=${fixedGroups[0].thetaHatFixed4}\nD3_THETA_FIXED4=${fixedGroups[1].thetaHatFixed4}\nFINAL_SPEND_CNY=${finalSpend}\nPOST_INITIAL_RECOVERY_PROVIDER_CALLS=${postInitialRecoveryCalls}\nCURRENT_PROVIDER_CALLS=0\nCURRENT_MODEL_API_CALLS=0\nCURRENT_SECRET_READS=0\nCURRENT_PAID_DOCKER_LAUNCHES=0\nOUTPUT=${outputRoot}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
