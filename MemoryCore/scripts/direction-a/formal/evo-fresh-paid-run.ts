import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type RealExecutionProfile } from "../../../src/evaluation/direction-a/formal/acquisition/execution-profile.js";
import { assertActualArmStartOrderFromJournal, assertJournalBoundAttemptIntegrityAttestation,
  createJournalBoundAttemptIntegrityAttestation, scheduledArms } from "../../../src/evaluation/direction-a/formal/acquisition/integrity.js";
import { hashCanonical } from "../../../src/evaluation/direction-a/formal/core/canonical.js";
import { assertFreshAuthorizationRequest, authorizeFreshExecutionPermit, loadFreshSecretsAfterAllPreconditions,
  type FreshAuthorizationRequest, type FreshImmutableGrant } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-execution-gate.js";
import { assertFreshFeatureScoringByteBindings, buildAcceptedEvoProcessFeatures, buildAcceptedEvoSharedFeatures,
  extractEvoNormalProcessEvidence, parseAcceptedEvoCaseSummary, scoreAcceptedEvoSource,
  type FreshFeatureScoringBindingSnapshot } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-feature-scoring.js";
import { FRESH_RUNTIME_ROOT, FRESH_N, assertFreshExactManifest, assertFreshPreparedExecutionManifest, assertFreshPreparedRuntimeBytes,
  assertFreshNoForbiddenTailTask, type FreshExactManifest, type FreshPreparedExecutionManifest } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-manifest.js";
import { FRESH_RESERVE_PER_TRIAL_CNY, FRESH_HISTORICAL_FRESH_SPEND_CNY, appendFreshBudgetLedgerEvent,
  freshSpendTelemetry, isProviderRefusal, projectFreshBudgetExposure, projectFreshBudgetLedger, reserveFreshWholeTaskBeforeStart,
  type FreshBudgetExposure, type FreshBudgetLedgerEvent } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-paid-authority.js";
import { assertDispatchAllowed, assertFreshCausalPhaseResume, freshBoundedRecoveryIsAvailable, freezePreYPolicy,
  nextFreshAction, reconcileFreshResumeState, sealAllNormalBarrier, sealFreshRunState, unlockCausalPhase,
  type FreshAllNormalBarrier, type FreshPolicyFreeze, type FreshNormalFeatureRow, type FreshPolicyModelSet,
  type FreshRunState, type FreshSlotState } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-prey-runtime.js";
import { assertN3PrefixEnvironmentManifest, N3_PREFIX_ENVIRONMENT_ATTEMPT_ID, N3_PREFIX_ENVIRONMENT_RECOVERY_ID,
  type N3PrefixEnvironmentManifest } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-prefix-environment-recovery.js";
import { verifyFreshRequiredBindings } from "../../../src/evaluation/direction-a/formal/evo-fresh/fresh-binding-verification.js";
import { type FrozenSourceModel } from "../../../src/evaluation/direction-a/formal/modeling/evo-continuous-adaptation.js";
import { CurrentFormalExecutionEventJournal } from "../../../src/evaluation/direction-a/formal/prepilot/execution-state-attestation.js";
import { AuthorizedFreshEvoHarborExecutor, TechnicalExecutionError } from "../../../src/evaluation/direction-a/formal/executors/evo-harbor-executor.js";

const repoRoot = resolve(process.cwd()); const workspaceRoot = resolve(repoRoot, "..");
const arg = (name: string): string | undefined => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const closureRoot = resolve(arg("--closure-root") ?? resolve(workspaceRoot, "Direction_A_Evo_Fresh_FinalRecovery_Closure_v1"));
const exactPath = resolve(arg("--exact") ?? resolve(closureRoot, "02_ACTIVE_PREFIX5_EXACT_MANIFEST.json"));
const runtimeRoot = FRESH_RUNTIME_ROOT; const preparedRoot = resolve(runtimeRoot, "prepared");
const profilePath = resolve(repoRoot, ".research/direction-a/current-formal/pilot/manifests/real-execution-profile-v3.json");
const harborExecutable = resolve(repoRoot, ".research/direction-a/v6.4-round-causal/.venv-harbor/Scripts/harbor.exe");
const docker = "C:/Program Files/Docker/Docker/resources/bin/docker.exe";
const statePath = resolve(runtimeRoot, "FRESH_N9_RUN_STATE.json"); const budgetLedgerPath = resolve(runtimeRoot, "FRESH_N9_BUDGET_LEDGER.jsonl");
const rowsPath = resolve(runtimeRoot, "FRESH_N9_NORMAL_FEATURE_ROWS.json"); const barrierPath = resolve(runtimeRoot, "FRESH_N9_ALL_NORMAL_BARRIER.json");
const sealPath = resolve(runtimeRoot, "FRESH_N9_PRE_Y_POLICY_FREEZE.json");
const integrityRoot = resolve(runtimeRoot, "attempt-integrity-attestations");
const executionJournal = new CurrentFormalExecutionEventJournal(resolve(runtimeRoot, "execution-events.jsonl"));
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const fileSha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const writeAtomic = (path: string, value: unknown): void => { mkdirSync(dirname(path), { recursive: true }); const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); renameSync(temp, path); };
const dockerReady = (): boolean => { try { execFileSync(docker, ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore" }); return true; } catch { return false; } };
const parseSecrets = (path: string): Record<string, string> => Object.fromEntries(readFileSync(path, "utf8").split(/\r?\n/).map((row) => row.trim())
  .filter((row) => row && !row.startsWith("#")).map((row) => { const at = row.indexOf("="); if (at < 1) throw new Error("FRESH_SECRET_CONFIG_MALFORMED");
    return [row.slice(0, at).trim(), row.slice(at + 1).trim()]; }));

const modes = ["--preflight", "--phase1-normal", "--phase2-freeze", "--phase3-causal"].filter((flag) => process.argv.includes(flag));
if (modes.length !== 1) throw new Error("FRESH_EXPLICIT_SINGLE_PHASE_REQUIRED:--preflight|--phase1-normal|--phase2-freeze|--phase3-causal");
const mode = modes[0];
if (mode === "--phase2-freeze" && process.argv.includes("--secret-config")) throw new Error("FRESH_PHASE2_SECRET_CONFIG_FORBIDDEN");

const request = readJson<FreshAuthorizationRequest>(resolve(arg("--request") ?? resolve(closureRoot, "10_NEW_FRESH_AUTHORIZATION_REQUEST.json"))); assertFreshAuthorizationRequest(request);
verifyFreshRequiredBindings(workspaceRoot, request);
const featureBindings = readJson<FreshFeatureScoringBindingSnapshot>(resolve(closureRoot, "frozen/post-t1/FRESH_FEATURE_SCORING_BINDING.json"));
// Defense in depth before permit construction and, critically, before any paid Phase1 NORMAL dispatch.
assertFreshFeatureScoringByteBindings(workspaceRoot, featureBindings);
const exact = readJson<FreshExactManifest>(exactPath); assertFreshExactManifest(exact);
assertFreshNoForbiddenTailTask(exact.tasks.map((row) => row.taskId));
if (request.preparedManifestSchema === "direction-a.evo-fresh-n9-prepared-manifest.v3") {
  // v3: the prepared bundle must carry the hash-bound external prefix artifact for n3.
  const prefixEnvironment = readJson<N3PrefixEnvironmentManifest>(resolve(closureRoot, "06_N3_PREFIX_ENVIRONMENT_MANIFEST.json"));
  assertN3PrefixEnvironmentManifest(repoRoot, prefixEnvironment);
}
const prepared = readJson<FreshPreparedExecutionManifest>(resolve(preparedRoot, "FRESH_N9_PREPARED_EXECUTION_MANIFEST.json"));
const profile = readJson<RealExecutionProfile>(profilePath); assertFreshPreparedExecutionManifest(prepared, exact);
await assertFreshPreparedRuntimeBytes(repoRoot, prepared, exact);
const grant = readJson<FreshImmutableGrant>(resolve(arg("--grant") ?? resolve(closureRoot, "authorization/FRESH_AUTHORIZATION_N9.json")));
const permit = authorizeFreshExecutionPermit({ grant, request, exact, prepared, profile });

if (mode === "--preflight") {
  assertFreshFeatureScoringByteBindings(workspaceRoot, featureBindings);
  const events = await executionJournal.read();
  if (events.some((row) => row.attemptId?.startsWith("fresh-n9-") && (row.eventType === "PAID_TRIAL_STARTED" || row.eventType === "PROVIDER_CALL_COMPLETED"))) {
    throw new Error("FRESH_PREFLIGHT_EXISTING_PAID_DISPATCH_REQUIRES_RESUME_PHASE");
  }
  console.log("FRESH_ZERO_PROVIDER_PREFLIGHT_PASS"); console.log(`FRESH_N=${FRESH_N}`); console.log("providerCalls=0 modelCalls=0 secretReads=0"); process.exit(0);
}

const ready = mode === "--phase2-freeze" ? false : dockerReady();
if (mode !== "--phase2-freeze" && !ready) throw new Error("FRESH_DOCKER_UNAVAILABLE_BEFORE_SECRET");
let budgetEvents: FreshBudgetLedgerEvent[] = existsSync(budgetLedgerPath) ? readFileSync(budgetLedgerPath, "utf8").split(/\r?\n/)
  .filter(Boolean).map((row) => JSON.parse(row) as FreshBudgetLedgerEvent) : [];
let budget: FreshBudgetExposure = projectFreshBudgetLedger(budgetEvents); projectFreshBudgetExposure(budget);
let state: FreshRunState = existsSync(statePath) ? readJson<FreshRunState>(statePath) : sealFreshRunState({
  schemaVersion: "direction-a.evo-fresh-n9-run-state.v1", phase: "PHASE1_NORMAL", tasks: exact.tasks, slots: [],
});
const eventsBefore = await executionJournal.read();
const journalSpendCny = eventsBefore.filter((row) => row.eventType === "PROVIDER_CALL_COMPLETED")
  .reduce((sum, row) => sum + (row.amountCny ?? 0), 0);
// Budget is telemetry: every number below is reported and none of it can stop the run.
console.log(`FRESH_SPEND_TELEMETRY ${JSON.stringify({ ...freshSpendTelemetry(budgetEvents),
  journalSpendCny: Number(journalSpendCny.toFixed(6)), declaredHistoricalSpendCny: FRESH_HISTORICAL_FRESH_SPEND_CNY,
  journalSpendMatchesDeclaration: Math.abs(journalSpendCny - FRESH_HISTORICAL_FRESH_SPEND_CNY) < 1e-6 })}`);
const stateBeforeResume = state;
const jobPresence = Object.fromEntries(state.slots.map((slot) => [slot.attemptId,
  existsSync(resolve(runtimeRoot, "harbor-jobs", `evo-fresh-n9-${slot.attemptId}`))]));
for (const slot of stateBeforeResume.slots) {
  if (!budgetEvents.some((event) => event.eventType === "RESERVATION_CREATED" && event.attemptId === slot.attemptId)) {
    throw new Error(`FRESH_RESUME_SLOT_WITHOUT_BUDGET_RESERVATION:${slot.attemptId}`);
  }
}
state = reconcileFreshResumeState({ state, events: eventsBefore,
  harborJobPresent: jobPresence });
const appendStartupBudget = (event: Parameters<typeof appendFreshBudgetLedgerEvent>[1]): void => {
  budgetEvents = appendFreshBudgetLedgerEvent(budgetEvents, event);
  mkdirSync(dirname(budgetLedgerPath), { recursive: true }); appendFileSync(budgetLedgerPath, `${JSON.stringify(budgetEvents.at(-1))}\n`, "utf8");
};
const openReservations = budgetEvents.filter((event) => event.eventType === "RESERVATION_CREATED"
  && !budgetEvents.some((settlement) => settlement.attemptId === event.attemptId && settlement.eventType !== "RESERVATION_CREATED"));
for (const created of openReservations) {
  const before = stateBeforeResume.slots.find((slot) => slot.attemptId === created.attemptId);
  const after = state.slots.find((slot) => slot.attemptId === created.attemptId);
  const attemptEvents = eventsBefore.filter((event) => event.attemptId === created.attemptId);
  const jobExists = jobPresence[created.attemptId] ?? existsSync(resolve(runtimeRoot, "harbor-jobs", `evo-fresh-n9-${created.attemptId}`));
  if (!before) {
    if (attemptEvents.length || jobExists) throw new Error(`FRESH_ORPHAN_RESERVATION_WITH_DISPATCH_EVIDENCE_GLOBAL_STOP:${created.attemptId}`);
    appendStartupBudget({ eventType: "RESERVATION_RELEASED", attemptId: created.attemptId,
      reservedCny: created.reservedCny, reservedCalls: created.reservedCalls });
  } else if (after?.status === "PENDING") {
    appendStartupBudget({ eventType: "RESERVATION_RELEASED", attemptId: created.attemptId,
      reservedCny: created.reservedCny, reservedCalls: created.reservedCalls });
  } else if (after?.status === "RECONCILED" || after?.status === "SCIENTIFIC_FAILURE" || after?.status === "TECHNICAL_INVALID") {
    appendStartupBudget({ eventType: "RESERVATION_RECONCILED", attemptId: created.attemptId,
      reservedCny: created.reservedCny, reservedCalls: created.reservedCalls,
      actualCny: attemptEvents.filter((event) => event.eventType === "PROVIDER_CALL_COMPLETED").reduce((sum, event) => sum + (event.amountCny ?? 0), 0),
      actualCalls: attemptEvents.filter((event) => event.eventType === "PROVIDER_CALL_COMPLETED").length });
  } else throw new Error(`FRESH_OPEN_RESERVATION_RESUME_AMBIGUOUS:${created.attemptId}`);
}
budget = projectFreshBudgetLedger(budgetEvents);
state = sealFreshRunState({ ...state, slots: state.slots.filter((row) => row.status !== "PENDING"), contentHash: undefined } as never);
writeAtomic(statePath, state);

const secretPath = resolve(arg("--secret-config") ?? resolve(repoRoot, ".research/direction-a/secrets/.env.direction-a.local"));
let executor: AuthorizedFreshEvoHarborExecutor | undefined;
const reservePerTrialCny = FRESH_RESERVE_PER_TRIAL_CNY;
async function executorAfterReservation(phase: "PHASE1_NORMAL" | "PHASE3_CAUSAL_Y"): Promise<AuthorizedFreshEvoHarborExecutor> {
  if (executor) return executor;
  const secrets = await loadFreshSecretsAfterAllPreconditions({ permit, phase, preparedManifestPass: true, dockerReady: ready,
    journalUnambiguous: true, reservationProven: budget.pendingUnknownReserveCny > 0, loader: async () => parseSecrets(secretPath) });
  await executionJournal.append({ eventType: "SECRET_CONTENT_READ", occurredAt: new Date().toISOString() });
  executor = new AuthorizedFreshEvoHarborExecutor({ permit, manifest: prepared, exactManifest: exact, profile, repoRoot,
    harborExecutable, runtimeRoot, secrets, executionJournal }); return executor;
}
function persist(): void { writeAtomic(statePath, state); }
function appendBudget(event: Parameters<typeof appendFreshBudgetLedgerEvent>[1]): void {
  budgetEvents = appendFreshBudgetLedgerEvent(budgetEvents, event); budget = projectFreshBudgetLedger(budgetEvents);
  mkdirSync(dirname(budgetLedgerPath), { recursive: true }); appendFileSync(budgetLedgerPath, `${JSON.stringify(budgetEvents.at(-1))}\n`, "utf8");
}
function reserveOne(attemptId: string): void { appendBudget({ eventType: "RESERVATION_CREATED", attemptId, reservedCny: reservePerTrialCny, reservedCalls: 12 }); persist(); }
async function reconcileOne(attemptId: string): Promise<void> {
  const events = await executionJournal.read(); const actualCny = events.filter((row) => row.attemptId === attemptId && row.eventType === "PROVIDER_CALL_COMPLETED")
    .reduce((sum, row) => sum + (row.amountCny ?? 0), 0); const actualCalls = events.filter((row) => row.attemptId === attemptId && row.eventType === "PROVIDER_CALL_COMPLETED").length;
  appendBudget({ eventType: "RESERVATION_RECONCILED", attemptId, reservedCny: reservePerTrialCny, reservedCalls: 12, actualCny, actualCalls }); persist();
}

async function attestCompletedPair(group: FreshPreparedExecutionManifest["groups"][number], pairIndex: number): Promise<void> {
  const allEvents = await executionJournal.read();
  const starts = allEvents.filter((row) => row.eventType === "PAID_TRIAL_STARTED" && row.taskId === group.taskId
    && row.causalGroupId === group.causalGroupId && row.pairIndex === pairIndex && (row.arm === "FULL" || row.arm === "REMOVE"))
    .map((row) => ({ sequence: row.sequence, eventHash: row.eventHash, attemptId: row.attemptId!, taskId: row.taskId!,
      causalGroupId: row.causalGroupId!, arm: row.arm as "FULL" | "REMOVE", pairIndex: row.pairIndex! }));
  const ordered = assertActualArmStartOrderFromJournal({ schedule: group.pairSchedule, pairIndex,
    taskId: group.taskId, causalGroupId: group.causalGroupId, starts });
  const scheduledArmOrder = group.pairSchedule.rows.find((row) => row.pairIndex === pairIndex)!.scheduledArmOrder;
  const expectedArms = scheduledArms(group.pairSchedule, pairIndex);
  const attestations = ordered.map((start) => createJournalBoundAttemptIntegrityAttestation({
    schemaVersion: "direction-a.attempt-integrity-attestation.v1", attemptId: start.attemptId,
    restoredStateHash: group.frozenPrefixHash, frozenStateHash: group.frozenPrefixHash,
    environmentSignatureHash: profile.environments.evo.environmentSignatureHash, taskId: group.taskId,
    roundId: `target-round-${group.targetRound}`, causalGroupId: group.causalGroupId, targetSpecHash: group.targetGroupHash,
    arm: start.arm, pairScheduleHash: group.pairSchedule.scheduleHash, scheduledArmOrder,
    actualArmStartOrdinal: (start.arm === expectedArms[0] ? 1 : 2), designBindingHash: exact.contentHash,
    q6SealHash: `NOT_APPLICABLE_FRESH_PREY_SEAL:${seal.contentHash}`, authorizationHash: request.contentHash,
    executionProfileHash: profile.contentHash, providerId: profile.environments.evo.providerId,
    modelId: profile.environments.evo.modelId, scaffoldId: profile.environments.evo.scaffoldId,
    decodingProfileId: profile.environments.evo.decodingProfileId, horizonId: `AGENT_TURNS_${profile.environments.evo.horizon.maxTurns}`,
    verifierId: profile.environments.evo.verifierId, verifierVersion: profile.environments.evo.verifierVersion,
    accessPolicyId: "FRESH_FROZEN_PRE_Y_POLICY", guideNormalizationHash: group.guideNormalizationHash,
    workspaceIsolationHash: start.arm === "FULL" ? group.fullTaskDirectoryHash : group.removeTaskDirectoryHash,
    contextIsolationPass: true,
  }, start));
  attestations.forEach(assertJournalBoundAttemptIntegrityAttestation);
  writeAtomic(resolve(integrityRoot, `${group.taskId}-pair-${pairIndex}.json`), { pairIndex, scheduledArmOrder,
    actualArmStartOrder: ordered.map((row) => row.arm), journalStartEventHashes: ordered.map((row) => row.eventHash), attestations });
}

function normalEvidence(attemptId: string, taskIndex: number): FreshNormalFeatureRow {
  const jobRoot = resolve(runtimeRoot, "harbor-jobs", `evo-fresh-n9-${attemptId}`);
  const trials = readdirSync(jobRoot, { withFileTypes: true }).filter((row) => row.isDirectory());
  if (trials.length !== 1) throw new Error(`FRESH_NORMAL_TRIAL_DIRECTORY_NOT_UNIQUE:${attemptId}`);
  const root = resolve(jobRoot, trials[0].name); const stdoutPath = resolve(root, "steps/target-round/verifier/test-stdout.txt");
  const trajectoryPath = resolve(root, "steps/target-round/agent/trajectory.json"); const instructionPath = resolve(repoRoot, prepared.groups[taskIndex].normalTaskPath, "steps/target-round/instruction.md");
  const stdout = readFileSync(stdoutPath, "utf8"); const trajectory = readFileSync(trajectoryPath, "utf8"); const instruction = readFileSync(instructionPath, "utf8");
  const normal = parseAcceptedEvoCaseSummary(stdout); const process = extractEvoNormalProcessEvidence(trajectory);
  const proposedDoc = readJson<any>(resolve(workspaceRoot, "Direction_A_PostCAL_Model_Value_v2_1/11_PROPOSED_V2_FINAL_MODEL.json"));
  const baselineDoc = readJson<any>(resolve(workspaceRoot, "Direction_A_PostCAL_Model_Value_v2_1/12_BASELINE_V2_FINAL_MODEL.json"));
  const proposedSource = { ...proposedDoc.model, contentHash: proposedDoc.contentHash } as FrozenSourceModel;
  const legacySource = { ...baselineDoc.model, contentHash: baselineDoc.contentHash } as FrozenSourceModel;
  const terminal = state.slots.find((row) => row.attemptId === attemptId)!;
  return { taskId: prepared.groups[taskIndex].taskId, causalGroupId: prepared.groups[taskIndex].causalGroupId, normalAttemptId: attemptId,
    normalStatus: terminal.status === "SCIENTIFIC_FAILURE" ? "SCIENTIFIC_FAILURE" : "RECONCILED",
    sharedFeatures: buildAcceptedEvoSharedFeatures({ targetRound: prepared.groups[taskIndex].targetRound, instruction, normal, process }),
    processFeatures: buildAcceptedEvoProcessFeatures(process),
    proposedSourceScore: scoreAcceptedEvoSource({ targetRound: prepared.groups[taskIndex].targetRound, instruction, normal, process, model: proposedSource }),
    legacySourceScore: scoreAcceptedEvoSource({ targetRound: prepared.groups[taskIndex].targetRound, instruction, normal, process, model: legacySource }),
    evidenceHashes: { verifierStdoutSha256: fileSha(stdoutPath), trajectorySha256: fileSha(trajectoryPath), instructionSha256: fileSha(instructionPath) } };
}

if (mode === "--phase1-normal") {
  if (state.phase !== "PHASE1_NORMAL") throw new Error("FRESH_PHASE1_REENTRY_AFTER_MANDATORY_STOP_FORBIDDEN");
  let rows: FreshNormalFeatureRow[] = existsSync(rowsPath) ? readJson<FreshNormalFeatureRow[]>(rowsPath) : [];
  for (const [taskIndex, group] of prepared.groups.entries()) {
    // Outcome-blind admission telemetry: reported once, before the task's very first attempt.
    if (!state.slots.some((row) => row.taskId === group.taskId)) {
      console.log(`FRESH_TASK_ADMISSION ${JSON.stringify(reserveFreshWholeTaskBeforeStart(budget, `n${group.prefixIndex}`))}`);
    }
    while (!state.slots.some((row) => row.taskId === group.taskId && row.arm === "NORMAL" && (row.status === "RECONCILED" || row.status === "SCIENTIFIC_FAILURE"))) {
      const same = state.slots.filter((row) => row.taskId === group.taskId && row.arm === "NORMAL");
      const ordinary = same.filter((row) => row.recoveryId === undefined);
      // The single bounded prefix-environment recovery replaces an exhausted ordinary pool; it is
      // never an ordinary replacement and it never rewrites the historical try-1..3 slots.
      const useRecovery = freshBoundedRecoveryIsAvailable(state.slots, group.taskId, group.causalGroupId, "NORMAL");
      const attempt = ordinary.filter((row) => row.status === "TECHNICAL_INVALID").length + 1;
      const attemptId = useRecovery ? N3_PREFIX_ENVIRONMENT_ATTEMPT_ID : `fresh-n9-phase1-${taskIndex + 1}-normal-try-${attempt}`;
      const desired: FreshSlotState = useRecovery
        ? { taskId: group.taskId, causalGroupId: group.causalGroupId, arm: "NORMAL", attempt: 1, attemptId, status: "PENDING",
            recoveryId: N3_PREFIX_ENVIRONMENT_RECOVERY_ID }
        : { taskId: group.taskId, causalGroupId: group.causalGroupId, arm: "NORMAL", attempt, attemptId, status: "PENDING" };
      const action = nextFreshAction(state.slots, desired); if (action === "SKIP_RECONCILED") break; if (action === "STOP_UNCERTAIN") throw new Error(`FRESH_UNCERTAIN_DISPATCH_GLOBAL_STOP:${attemptId}`);
      assertDispatchAllowed(state, "NORMAL"); reserveOne(attemptId); state = sealFreshRunState({ ...state, slots: [...state.slots, { ...desired, status: "DISPATCHED" }], contentHash: undefined } as never); persist();
      try {
        const result = await (await executorAfterReservation("PHASE1_NORMAL")).executeNormal(attemptId, group);
        const failed = (result.technicalMetadata as { gradedOutcome?: { strictPass?: boolean } }).gradedOutcome?.strictPass === false;
        state = sealFreshRunState({ ...state, slots: state.slots.map((row) => row.attemptId === attemptId ? { ...row, status: failed ? "SCIENTIFIC_FAILURE" : "RECONCILED" } : row), contentHash: undefined } as never);
        await reconcileOne(attemptId); rows = [...rows.filter((row) => row.taskId !== group.taskId), normalEvidence(attemptId, taskIndex)]; writeAtomic(rowsPath, rows); break;
      } catch (error) {
        if (!(error instanceof TechnicalExecutionError)) { state = sealFreshRunState({ ...state, slots: state.slots.map((row) => row.attemptId === attemptId ? { ...row, status: "UNCERTAIN" } : row), contentHash: undefined } as never); persist(); throw error; }
        // The only budget-side stop left: the provider itself refuses the request (balance / quota).
        if (isProviderRefusal(error.message) || isProviderRefusal(String((error as { reason?: string }).reason ?? ""))) {
          persist();
          throw new Error(`FRESH_PROVIDER_REFUSAL_MANDATORY_STOP:${attemptId}:${error.message}`);
        }
        if (useRecovery && /flowr|prefix.?environment|binary missing from PATH/i.test(error.message)) {
          // The recovery was supposed to remove exactly this failure; do not retry it in a loop.
          state = sealFreshRunState({ ...state, slots: state.slots.map((row) => row.attemptId === attemptId ? { ...row, status: "TECHNICAL_INVALID" } : row), contentHash: undefined } as never);
          await reconcileOne(attemptId); persist();
          throw new Error(`STOP_CORE_DECISION_REQUIRED_N3_PREFIX_ENVIRONMENT_PROVENANCE:${attemptId}`);
        }
        state = sealFreshRunState({ ...state, slots: state.slots.map((row) => row.attemptId === attemptId ? { ...row, status: "TECHNICAL_INVALID" } : row), contentHash: undefined } as never); await reconcileOne(attemptId);
      }
    }
  }
  const events = await executionJournal.read(); const barrier = sealAllNormalBarrier({ tasks: exact.tasks, slots: state.slots, rows, executionEvents: events, budgetExposure: budget });
  writeAtomic(barrierPath, barrier); state = sealFreshRunState({ ...state, phase: "PHASE2_PRE_Y_FREEZE", normalBarrierHash: barrier.contentHash, contentHash: undefined } as never); persist();
  console.log("FRESH_PHASE1_ALL_NORMAL_COMPLETE_MANDATORY_STOP"); process.exit(0);
}

if (mode === "--phase2-freeze") {
  if (state.phase !== "PHASE2_PRE_Y_FREEZE" || !existsSync(barrierPath)) throw new Error("FRESH_PHASE2_REQUIRES_EXACT_PHASE1_BARRIER");
  assertFreshFeatureScoringByteBindings(workspaceRoot, featureBindings);
  const barrier = readJson<FreshAllNormalBarrier>(barrierPath); const events = await executionJournal.read();
  const proposed = readJson<any>(resolve(closureRoot, "frozen/post-t1/11_FINAL_PROPOSED_MODEL_FREEZE.json"));
  const baseline = readJson<any>(resolve(closureRoot, "frozen/post-t1/12_FINAL_PRIMARY_BASELINE_FREEZE.json"));
  const strong = readJson<any>(resolve(closureRoot, "frozen/post-t1/13_FINAL_STRONG_COMPARATOR_FREEZE.json"));
  const modelSet = readJson<any>(resolve(closureRoot, "frozen/post-t1/16_FINAL_MODEL_SET_FREEZE.json"));
  const models: FreshPolicyModelSet = { proposed: proposed.fittedModel, primaryBaseline: baseline.fittedModel, strongComparator: strong.fittedModel,
    modelHashes: { proposed: hashCanonical(proposed.fittedModel), primaryBaseline: hashCanonical(baseline.fittedModel), strongComparator: hashCanonical(strong.fittedModel) } };
  const seal = freezePreYPolicy({ tasks: exact.tasks, barrier, models, modelSetHash: modelSet.contentHash, featureScoringBindings: featureBindings, executionEvents: events });
  writeAtomic(sealPath, seal); console.log("FRESH_PHASE2_PRE_Y_POLICY_FREEZE_MANDATORY_STOP"); process.exit(0);
}

if (!existsSync(barrierPath) || !existsSync(sealPath)) throw new Error("FRESH_PHASE3_REQUIRES_EXACT_PHASE2_SEAL");
assertFreshFeatureScoringByteBindings(workspaceRoot, featureBindings);
const barrier = readJson<FreshAllNormalBarrier>(barrierPath); const seal = readJson<FreshPolicyFreeze>(sealPath); const events = await executionJournal.read();
const modelSet = readJson<any>(resolve(closureRoot, "frozen/post-t1/16_FINAL_MODEL_SET_FREEZE.json"));
if (state.phase === "COMPLETE") { console.log("FRESH_PHASE3_FIXED4_COMPLETE_MANDATORY_STOP"); process.exit(0); }
if (state.phase === "PHASE2_PRE_Y_FREEZE") state = unlockCausalPhase({ state, seal, barrier, exactModelSetHash: modelSet.contentHash,
  exactFeatureScoringBindingsHash: featureBindings.contentHash, executionEvents: events });
else assertFreshCausalPhaseResume({ state, seal, barrier, exactModelSetHash: modelSet.contentHash,
  exactFeatureScoringBindingsHash: featureBindings.contentHash, executionEvents: events });
persist();
for (const [taskIndex, group] of prepared.groups.entries()) {
  for (const pairIndex of [1, 2, 3, 4]) {
   const arms = scheduledArms(group.pairSchedule, pairIndex).map((arm) => `PAIR_${pairIndex}_${arm}` as FreshSlotState["arm"]);
   for (const armName of arms) {
    while (!state.slots.some((row) => row.taskId === group.taskId && row.arm === armName && (row.status === "RECONCILED" || row.status === "SCIENTIFIC_FAILURE"))) {
      const same = state.slots.filter((row) => row.taskId === group.taskId && row.arm === armName); const attempt = same.filter((row) => row.status === "TECHNICAL_INVALID").length + 1;
      const attemptId = `fresh-n9-phase3-${taskIndex + 1}-${armName.toLowerCase()}-try-${attempt}`;
      const desired: FreshSlotState = { taskId: group.taskId, causalGroupId: group.causalGroupId, arm: armName, attempt, attemptId, status: "PENDING" };
      const action = nextFreshAction(state.slots, desired); if (action === "SKIP_RECONCILED") break; if (action === "STOP_UNCERTAIN") throw new Error(`FRESH_UNCERTAIN_DISPATCH_GLOBAL_STOP:${attemptId}`);
      assertDispatchAllowed(state, armName, seal.contentHash); reserveOne(attemptId); state = sealFreshRunState({ ...state, slots: [...state.slots, { ...desired, status: "DISPATCHED" }], contentHash: undefined } as never); persist();
      const match = /^PAIR_([1-4])_(FULL|REMOVE)$/.exec(armName)!; const arm = match[2] as "FULL" | "REMOVE";
      try {
        const result = await (await executorAfterReservation("PHASE3_CAUSAL_Y")).execute({ attemptId,
          normalUnit: { taskId: group.taskId, statisticalClusterId: group.statisticalClusterId, frozenStateHash: group.frozenPrefixHash } as never,
          armConfig: { causalGroupId: group.causalGroupId, statisticalClusterId: group.statisticalClusterId, frozenStateHash: group.frozenPrefixHash,
            targetSpecHash: group.targetGroupHash, arm, pairIndex } as never });
        const failed = (result.technicalMetadata as { gradedOutcome?: { strictPass?: boolean } }).gradedOutcome?.strictPass === false;
        state = sealFreshRunState({ ...state, slots: state.slots.map((row) => row.attemptId === attemptId ? { ...row, status: failed ? "SCIENTIFIC_FAILURE" : "RECONCILED" } : row), contentHash: undefined } as never);
        await reconcileOne(attemptId); break;
      } catch (error) {
        if (!(error instanceof TechnicalExecutionError)) { state = sealFreshRunState({ ...state, slots: state.slots.map((row) => row.attemptId === attemptId ? { ...row, status: "UNCERTAIN" } : row), contentHash: undefined } as never); persist(); throw error; }
        state = sealFreshRunState({ ...state, slots: state.slots.map((row) => row.attemptId === attemptId ? { ...row, status: "TECHNICAL_INVALID" } : row), contentHash: undefined } as never); await reconcileOne(attemptId);
      }
    }
   }
   await attestCompletedPair(group, pairIndex);
  }
}
state = sealFreshRunState({ ...state, phase: "COMPLETE", contentHash: undefined } as never); persist();
console.log("FRESH_PHASE3_FIXED4_COMPLETE_MANDATORY_STOP");
