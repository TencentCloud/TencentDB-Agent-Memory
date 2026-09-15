import { hashCanonical, immutableCopy } from "../core/canonical.js";
import { predictEvoContinuousModel, type FittedEvoContinuousModel } from "../modeling/evo-continuous-adaptation.js";
import { roundHalfUp } from "../modeling/evo-engineering-first.js";
import type { CurrentFormalExecutionEvent } from "../prepilot/execution-state-attestation.js";
import { FRESH_N, FRESH_PREFIX_HASH, FRESH_TASK_IDS, FRESH_FORBIDDEN_TAIL_TASK_IDS, assertFreshTaskSet,
  type FreshTaskIdentity } from "./fresh-manifest.js";
import { projectFreshBudgetExposure, FRESH_MAX_ATTEMPTS_PER_TASK, FRESH_TECHNICAL_REPLACEMENT_LIMIT_PER_TASK,
  type FreshBudgetExposure } from "./fresh-paid-authority.js";
import { N3_PREFIX_ENVIRONMENT_ATTEMPT_ID, N3_PREFIX_ENVIRONMENT_RECOVERY_ID, N3_PREFIX_ENVIRONMENT_TASK_ID } from "./fresh-prefix-environment-recovery.js";
import type { FreshFeatureScoringBindingSnapshot } from "./fresh-feature-scoring.js";

export const FRESH_PRIORITY_COVERAGES = [0.4, 0.6, 0.7, 0.8] as const;
export type FreshPhase = "PHASE1_NORMAL" | "PHASE2_PRE_Y_FREEZE" | "PHASE3_CAUSAL_Y" | "COMPLETE";
export type FreshTerminalStatus = "PENDING" | "RECONCILED" | "SCIENTIFIC_FAILURE" | "TECHNICAL_INVALID" | "DISPATCHED" | "UNCERTAIN";
export type FreshArm = "NORMAL" | `PAIR_${1 | 2 | 3 | 4}_${"FULL" | "REMOVE"}`;

export interface FreshSlotState {
  taskId: string;
  causalGroupId: string;
  arm: FreshArm;
  attempt: number;
  attemptId: string;
  /**
   * Set only on the single versioned bounded prefix-environment recovery attempt. Such a slot is
   * deliberately outside the ordinary technical replacement pool, so it never widens the frozen
   * 11-attempt-per-task protocol bound and it can run at most once per arm.
   */
  recoveryId?: typeof N3_PREFIX_ENVIRONMENT_RECOVERY_ID;
  status: FreshTerminalStatus;
}

export interface FreshRunState {
  schemaVersion: "direction-a.evo-fresh-n9-run-state.v1";
  phase: FreshPhase;
  tasks: readonly FreshTaskIdentity[];
  slots: readonly FreshSlotState[];
  normalBarrierHash?: string;
  preYSealHash?: string;
  sealedModelSetHash?: string;
  sealedFeatureScoringBindingsHash?: string;
  contentHash: string;
}

export interface FreshNormalFeatureRow {
  taskId: string;
  causalGroupId: string;
  normalAttemptId: string;
  normalStatus: "RECONCILED" | "SCIENTIFIC_FAILURE";
  sharedFeatures: Readonly<Record<string, number>>;
  processFeatures: Readonly<Record<string, number>>;
  proposedSourceScore: number;
  legacySourceScore: number;
  evidenceHashes: Readonly<Record<string, string>>;
}

export interface FreshAllNormalBarrierBody {
  schemaVersion: "direction-a.evo-fresh-n9-all-normal-complete.v1";
  exactTaskIds: readonly string[];
  exactCausalGroupIds: readonly string[];
  canonicalNormalAttemptIds: readonly string[];
  rows: readonly FreshNormalFeatureRow[];
  executionJournalHead: string;
  executionJournalEventCount: number;
  budgetExposure: FreshBudgetExposure;
  causalYDispatchCount: 0;
  status: "PASS";
}
export type FreshAllNormalBarrier = FreshAllNormalBarrierBody & { contentHash: string };

export interface FreshPolicyModelSet {
  proposed: FittedEvoContinuousModel;
  primaryBaseline: FittedEvoContinuousModel;
  strongComparator: FittedEvoContinuousModel;
  modelHashes: { proposed: string; primaryBaseline: string; strongComparator: string };
}

export interface FreshPolicyRow {
  taskId: string;
  proposedScore: number;
  primaryBaselineScore: number;
  strongComparatorScore: number;
  proposedRank: number;
  primaryBaselineRank: number;
  strongComparatorRank: number;
}

export interface FreshPolicyFreezeBody {
  schemaVersion: "direction-a.evo-fresh-n9-pre-y-policy-freeze.v1";
  phase1BarrierHash: string;
  modelSetHash: string;
  featureScoringBindingsHash: string;
  executionJournalHeadAtFreeze: string;
  executionJournalEventCountAtFreeze: number;
  causalYDispatchCountAtFreeze: 0;
  rows: readonly FreshPolicyRow[];
  acceptedCount70: number;
  accepted70: { proposed: readonly string[]; primaryBaseline: readonly string[]; strongComparator: readonly string[] };
  priorityObjects: Readonly<Record<"40" | "60" | "70" | "80", { acceptedCount: number; proposed: readonly string[];
    primaryBaseline: readonly string[]; strongComparator: readonly string[] }>>;
}
export type FreshPolicyFreeze = FreshPolicyFreezeBody & { contentHash: string };

function assertHashDocument(value: { contentHash: string } & Record<string, unknown>, label: string): void {
  const { contentHash, ...body } = value;
  if (hashCanonical(body) !== contentHash) throw new Error(`${label}_CONTENT_HASH_MISMATCH`);
}

function journalHead(events: readonly CurrentFormalExecutionEvent[]): string {
  return events.at(-1)?.eventHash ?? "GENESIS";
}

function isFreshEvent(event: CurrentFormalExecutionEvent): boolean {
  return event.attemptId?.startsWith("fresh-n9-") ?? false;
}

function isCausalStart(event: CurrentFormalExecutionEvent): boolean {
  return isFreshEvent(event) && event.eventType === "PAID_TRIAL_STARTED" && event.arm !== "NORMAL";
}

export function assertFreshAuthoritativeExecutionJournal(events: readonly CurrentFormalExecutionEvent[]): void {
  const starts = events.filter((row) => isFreshEvent(row) && row.eventType === "PAID_TRIAL_STARTED");
  const finishes = events.filter((row) => isFreshEvent(row) && row.eventType === "PAID_TRIAL_FINISHED");
  const seen = new Set<string>();
  for (const start of starts) {
    if (!start.attemptId || seen.has(start.attemptId)) throw new Error("FRESH_DUPLICATE_UNRECONCILED_DISPATCH_GLOBAL_STOP");
    seen.add(start.attemptId);
    const matched = finishes.filter((row) => row.attemptId === start.attemptId);
    if (matched.length > 1) throw new Error("FRESH_DUPLICATE_FINISH_GLOBAL_STOP");
  }
  if (finishes.some((row) => !starts.some((start) => start.attemptId === row.attemptId))) throw new Error("FRESH_FINISH_WITHOUT_DISPATCH_GLOBAL_STOP");
}

export function assertFreshSlot(slot: FreshSlotState): void {
  if (FRESH_FORBIDDEN_TAIL_TASK_IDS.includes(slot.taskId)) throw new Error(`FRESH_TASK6_PLUS_STRUCTURALLY_FORBIDDEN:${slot.taskId}`);
  if (!/^(NORMAL|PAIR_[1-4]_(FULL|REMOVE))$/.test(slot.arm)) throw new Error("FRESH_PAIR5_OR_INVALID_ARM_FORBIDDEN");
  if (!slot.attemptId.startsWith("fresh-n9-")) throw new Error("FRESH_TECHNICAL_REPLACEMENT_IDENTITY_INVALID");
  if (slot.recoveryId !== undefined) {
    if (slot.recoveryId !== N3_PREFIX_ENVIRONMENT_RECOVERY_ID || slot.attempt !== 1 || slot.arm !== "NORMAL"
      || slot.taskId !== N3_PREFIX_ENVIRONMENT_TASK_ID || slot.attemptId !== N3_PREFIX_ENVIRONMENT_ATTEMPT_ID) {
      throw new Error("FRESH_BOUNDED_RECOVERY_SLOT_IDENTITY_INVALID");
    }
    return;
  }
  if (!Number.isInteger(slot.attempt) || slot.attempt < 1 || slot.attempt > 3) {
    throw new Error("FRESH_TECHNICAL_REPLACEMENT_IDENTITY_INVALID");
  }
}

export function assertFreshTaskReplacementPool(slots: readonly FreshSlotState[]): void {
  const recoverySlots = slots.filter((row) => row.recoveryId !== undefined);
  if (recoverySlots.length > 1) throw new Error("FRESH_BOUNDED_RECOVERY_MAY_RUN_ONCE");
  for (const taskId of new Set(slots.map((row) => row.taskId))) {
    if (FRESH_FORBIDDEN_TAIL_TASK_IDS.includes(taskId)) throw new Error(`FRESH_TASK6_PLUS_STRUCTURALLY_FORBIDDEN:${taskId}`);
    const ordinary = slots.filter((row) => row.taskId === taskId && row.recoveryId === undefined);
    const recovery = slots.filter((row) => row.taskId === taskId && row.recoveryId !== undefined);
    if (ordinary.filter((row) => row.attempt > 1).length > FRESH_TECHNICAL_REPLACEMENT_LIMIT_PER_TASK) {
      throw new Error(`FRESH_TASK_TECHNICAL_REPLACEMENT_LIMIT_EXCEEDED:${taskId}`);
    }
    if (ordinary.length > FRESH_MAX_ATTEMPTS_PER_TASK) throw new Error(`FRESH_MAX_TRIALS_PER_TASK_EXCEEDED:${taskId}`);
    if (recovery.length > 1) throw new Error("FRESH_BOUNDED_RECOVERY_MAY_RUN_ONCE");
    if (recovery.length && (taskId !== N3_PREFIX_ENVIRONMENT_TASK_ID || recovery[0].arm !== "NORMAL")) {
      throw new Error("FRESH_BOUNDED_RECOVERY_NOT_AUTHORIZED_FOR_THIS_SLOT");
    }
  }
  if (recoverySlots.some((row) => row.taskId !== N3_PREFIX_ENVIRONMENT_TASK_ID)) throw new Error("FRESH_BOUNDED_RECOVERY_NOT_AUTHORIZED_FOR_THIS_TASK");
  if (new Set(slots.map((row) => row.taskId)).size > FRESH_N) throw new Error("FRESH_SAMPLE_WIDENING_FORBIDDEN");
  if (slots.filter((row) => row.recoveryId === undefined).length > FRESH_N * FRESH_MAX_ATTEMPTS_PER_TASK) {
    throw new Error("FRESH_MAX_TOTAL_TRIALS_EXCEEDED");
  }
}

/** True when this task/arm may legally start its single bounded recovery attempt. */
export function freshBoundedRecoveryIsAvailable(slots: readonly FreshSlotState[], taskId: string,
  causalGroupId: string, arm: FreshArm): boolean {
  if (taskId !== N3_PREFIX_ENVIRONMENT_TASK_ID || arm !== "NORMAL") return false;
  const same = slots.filter((row) => row.taskId === taskId && row.causalGroupId === causalGroupId && row.arm === arm);
  if (same.some((row) => row.recoveryId !== undefined)) return false;
  if (same.some((row) => row.status === "DISPATCHED" || row.status === "UNCERTAIN")) return false;
  if (same.some((row) => row.status === "RECONCILED" || row.status === "SCIENTIFIC_FAILURE")) return false;
  const ordinary = same.filter((row) => row.recoveryId === undefined);
  return ordinary.length >= 1 + FRESH_TECHNICAL_REPLACEMENT_LIMIT_PER_TASK
    && ordinary.every((row) => row.status === "TECHNICAL_INVALID");
}

export function sealFreshRunState(body: Omit<FreshRunState, "contentHash">): FreshRunState {
  assertFreshTaskSet(body.tasks); body.slots.forEach(assertFreshSlot); assertFreshTaskReplacementPool(body.slots);
  const identities = new Set(body.tasks.map((row) => `${row.taskId}:${row.canonicalCausalGroupId}`));
  if (body.slots.some((slot) => !identities.has(`${slot.taskId}:${slot.causalGroupId}`))) throw new Error("FRESH_SLOT_FOREIGN_TASK_OR_GROUP");
  return immutableCopy({ ...body, contentHash: hashCanonical(body) }) as FreshRunState;
}

export function assertFreshRunState(state: FreshRunState): void {
  assertHashDocument(state as unknown as { contentHash: string } & Record<string, unknown>, "FRESH_RUN_STATE");
  assertFreshTaskSet(state.tasks); state.slots.forEach(assertFreshSlot); assertFreshTaskReplacementPool(state.slots);
  const identities = new Set(state.tasks.map((row) => `${row.taskId}:${row.canonicalCausalGroupId}`));
  if (state.slots.some((slot) => !identities.has(`${slot.taskId}:${slot.causalGroupId}`))) throw new Error("FRESH_SLOT_FOREIGN_TASK_OR_GROUP");
}

export function assertDispatchAllowed(state: FreshRunState, requested: FreshArm, exactPreYSealHash?: string): void {
  assertFreshRunState(state);
  if (!/^(NORMAL|PAIR_[1-4]_(FULL|REMOVE))$/.test(requested)) throw new Error("FRESH_PAIR5_OR_INVALID_ARM_FORBIDDEN");
  if (requested === "NORMAL") {
    if (state.phase !== "PHASE1_NORMAL") throw new Error("FRESH_NORMAL_DISPATCH_OUTSIDE_PHASE1");
    return;
  }
  if (state.phase !== "PHASE3_CAUSAL_Y") throw new Error("FRESH_CAUSAL_Y_LOCKED_UNTIL_PRE_Y_SEAL");
  if (!state.normalBarrierHash || !state.preYSealHash || !state.sealedModelSetHash || !state.sealedFeatureScoringBindingsHash) {
    throw new Error("FRESH_CAUSAL_Y_REQUIRED_SEALS_MISSING");
  }
  if (state.preYSealHash !== exactPreYSealHash) throw new Error("FRESH_CAUSAL_Y_PRE_Y_SEAL_DRIFT");
}

export function nextFreshAction(slots: readonly FreshSlotState[], desired: FreshSlotState): "DISPATCH" | "SKIP_RECONCILED" | "STOP_UNCERTAIN" {
  assertFreshSlot(desired); assertFreshTaskReplacementPool(slots);
  const same = slots.filter((slot) => slot.taskId === desired.taskId && slot.causalGroupId === desired.causalGroupId && slot.arm === desired.arm);
  if (same.some((slot) => slot.status === "DISPATCHED" || slot.status === "UNCERTAIN")) return "STOP_UNCERTAIN";
  if (same.some((slot) => slot.status === "RECONCILED" || slot.status === "SCIENTIFIC_FAILURE")) return "SKIP_RECONCILED";
  if (desired.recoveryId !== undefined) {
    // The versioned bounded recovery replaces the ordinary pool, it never extends it.
    if (!freshBoundedRecoveryIsAvailable(slots, desired.taskId, desired.causalGroupId, desired.arm)) {
      throw new Error("FRESH_BOUNDED_RECOVERY_NOT_AVAILABLE");
    }
    if (same.some((slot) => slot.recoveryId !== undefined)) throw new Error("FRESH_BOUNDED_RECOVERY_MAY_RUN_ONCE");
    assertFreshTaskReplacementPool([...slots, desired]);
    return "DISPATCH";
  }
  const invalid = same.filter((slot) => slot.status === "TECHNICAL_INVALID" && slot.recoveryId === undefined);
  if (desired.attempt !== invalid.length + 1) throw new Error("FRESH_RETRY_MUST_PRESERVE_ORIGINAL_TASK_SLOT_ARM_IDENTITY");
  const replacements = slots.filter((slot) => slot.taskId === desired.taskId && slot.recoveryId === undefined && slot.attempt > 1).length;
  if (desired.attempt > 1 && replacements >= FRESH_TECHNICAL_REPLACEMENT_LIMIT_PER_TASK) {
    throw new Error("FRESH_TASK_TECHNICAL_REPLACEMENT_LIMIT_EXCEEDED");
  }
  assertFreshTaskReplacementPool([...slots, desired]);
  return "DISPATCH";
}

export function reconcileFreshResumeState(input: { state: FreshRunState; events: readonly CurrentFormalExecutionEvent[];
  harborJobPresent: Readonly<Record<string, boolean>> }): FreshRunState {
  assertFreshRunState(input.state); assertFreshAuthoritativeExecutionJournal(input.events);
  const slots = input.state.slots.map((slot) => {
    if (slot.status !== "DISPATCHED") return { ...slot };
    const starts = input.events.filter((row) => row.eventType === "PAID_TRIAL_STARTED" && row.attemptId === slot.attemptId);
    const finishes = input.events.filter((row) => row.eventType === "PAID_TRIAL_FINISHED" && row.attemptId === slot.attemptId);
    if (!starts.length && !finishes.length && !input.harborJobPresent[slot.attemptId]) return { ...slot, status: "PENDING" as const };
    if (starts.length === 1 && finishes.length === 1) return { ...slot,
      status: finishes[0].terminalStatus === "TECHNICAL_INVALID" ? "TECHNICAL_INVALID" as const : "RECONCILED" as const };
    throw new Error(`FRESH_UNCERTAIN_DISPATCH_GLOBAL_STOP:${slot.attemptId}`);
  });
  const { contentHash: _oldHash, ...body } = input.state;
  return sealFreshRunState({ ...body, slots });
}

export function sealAllNormalBarrier(input: { tasks: readonly FreshTaskIdentity[]; slots: readonly FreshSlotState[];
  rows: readonly FreshNormalFeatureRow[]; executionEvents: readonly CurrentFormalExecutionEvent[]; budgetExposure: FreshBudgetExposure }): FreshAllNormalBarrier {
  assertFreshTaskSet(input.tasks); input.slots.forEach(assertFreshSlot); assertFreshTaskReplacementPool(input.slots);
  assertFreshAuthoritativeExecutionJournal(input.executionEvents); projectFreshBudgetExposure(input.budgetExposure);
  if (input.executionEvents.some(isCausalStart) || input.slots.some((slot) => slot.arm !== "NORMAL")) {
    throw new Error("FRESH_CAUSAL_Y_OBSERVED_BEFORE_NORMAL_BARRIER");
  }
  if (input.rows.length !== FRESH_N || input.slots.filter((row) => row.status === "RECONCILED" || row.status === "SCIENTIFIC_FAILURE").length !== FRESH_N) {
    throw new Error("FRESH_ALL_NORMAL_EXACT_N9_ROWS_REQUIRED");
  }
  const rowByTask = new Map(input.rows.map((row) => [row.taskId, row]));
  if (rowByTask.size !== FRESH_N || input.rows.some((row) => !FRESH_TASK_IDS.includes(row.taskId))) throw new Error("FRESH_NORMAL_ROW_DUPLICATE_OR_FOREIGN_TASK");
  for (const task of input.tasks) {
    const row = rowByTask.get(task.taskId);
    const terminal = input.slots.filter((slot) => slot.taskId === task.taskId && slot.causalGroupId === task.canonicalCausalGroupId
      && slot.arm === "NORMAL" && (slot.status === "RECONCILED" || slot.status === "SCIENTIFIC_FAILURE"));
    if (!row || row.causalGroupId !== task.canonicalCausalGroupId || terminal.length !== 1 || row.normalAttemptId !== terminal[0].attemptId
      || row.normalStatus !== terminal[0].status) throw new Error(`FRESH_NORMAL_EXACT_IDENTITY_BARRIER_MISMATCH:${task.taskId}`);
  }
  const orderedRows = input.tasks.map((task) => rowByTask.get(task.taskId)!);
  const body: FreshAllNormalBarrierBody = { schemaVersion: "direction-a.evo-fresh-n9-all-normal-complete.v1",
    exactTaskIds: input.tasks.map((task) => task.taskId), exactCausalGroupIds: input.tasks.map((task) => task.canonicalCausalGroupId),
    canonicalNormalAttemptIds: orderedRows.map((row) => row.normalAttemptId), rows: orderedRows,
    executionJournalHead: journalHead(input.executionEvents), executionJournalEventCount: input.executionEvents.length,
    budgetExposure: input.budgetExposure, causalYDispatchCount: 0, status: "PASS" };
  return immutableCopy({ ...body, contentHash: hashCanonical(body) }) as FreshAllNormalBarrier;
}

export function assertFreshAllNormalBarrier(barrier: FreshAllNormalBarrier, tasks: readonly FreshTaskIdentity[]): void {
  assertHashDocument(barrier as unknown as { contentHash: string } & Record<string, unknown>, "FRESH_ALL_NORMAL_BARRIER");
  assertFreshTaskSet(tasks);
  if (barrier.schemaVersion !== "direction-a.evo-fresh-n9-all-normal-complete.v1" || barrier.status !== "PASS"
    || barrier.causalYDispatchCount !== 0 || barrier.rows.length !== FRESH_N
    || hashCanonical(barrier.exactTaskIds) !== hashCanonical(tasks.map((row) => row.taskId))
    || hashCanonical(barrier.exactCausalGroupIds) !== hashCanonical(tasks.map((row) => row.canonicalCausalGroupId))) {
    throw new Error("FRESH_ALL_NORMAL_BARRIER_EXACT_N9_SCOPE_MISMATCH");
  }
  barrier.rows.forEach((row, index) => {
    if (row.taskId !== tasks[index].taskId || row.causalGroupId !== tasks[index].canonicalCausalGroupId
      || row.normalAttemptId !== barrier.canonicalNormalAttemptIds[index]) throw new Error("FRESH_ALL_NORMAL_BARRIER_ROW_DERIVATION_MISMATCH");
  });
  projectFreshBudgetExposure(barrier.budgetExposure);
}

function rankRows(rows: readonly { taskId: string; score: number }[]): Map<string, number> {
  return new Map([...rows].sort((a, b) => b.score - a.score || a.taskId.localeCompare(b.taskId)).map((row, index) => [row.taskId, index + 1]));
}
function accepted(rows: readonly FreshPolicyRow[], field: "proposedScore" | "primaryBaselineScore" | "strongComparatorScore", count: number): string[] {
  return [...rows].sort((a, b) => b[field] - a[field] || a.taskId.localeCompare(b.taskId)).slice(0, count).map((row) => row.taskId);
}

export function freezePreYPolicy(input: { tasks: readonly FreshTaskIdentity[]; barrier: FreshAllNormalBarrier; models: FreshPolicyModelSet;
  modelSetHash: string; featureScoringBindings: FreshFeatureScoringBindingSnapshot; executionEvents: readonly CurrentFormalExecutionEvent[] }): FreshPolicyFreeze {
  assertFreshTaskSet(input.tasks); assertFreshAllNormalBarrier(input.barrier, input.tasks); assertFreshAuthoritativeExecutionJournal(input.executionEvents);
  if (input.executionEvents.some(isCausalStart)) throw new Error("FRESH_PHASE2_AFTER_CAUSAL_DISPATCH_FORBIDDEN");
  if (input.executionEvents.length !== input.barrier.executionJournalEventCount || journalHead(input.executionEvents) !== input.barrier.executionJournalHead) {
    throw new Error("FRESH_PHASE2_AUTHORITATIVE_JOURNAL_DRIFT");
  }
  assertHashDocument(input.featureScoringBindings as unknown as { contentHash: string } & Record<string, unknown>, "FRESH_FEATURE_SCORING_BINDINGS");
  if (hashCanonical(input.models.proposed) !== input.models.modelHashes.proposed
    || hashCanonical(input.models.primaryBaseline) !== input.models.modelHashes.primaryBaseline
    || hashCanonical(input.models.strongComparator) !== input.models.modelHashes.strongComparator) throw new Error("FRESH_ACTUAL_MODEL_OBJECT_HASH_MISMATCH");
  const raw = input.barrier.rows.map((row, index) => {
    const task = input.tasks[index];
    const common = { causalGroupId: row.causalGroupId, statisticalClusterId: task.statisticalClusterId, thetaHatFixed4: 0,
      sharedFeatures: row.sharedFeatures, processFeatures: row.processFeatures };
    return { taskId: row.taskId,
      proposedScore: predictEvoContinuousModel(input.models.proposed, { ...common, sourceScore: row.proposedSourceScore }),
      primaryBaselineScore: predictEvoContinuousModel(input.models.primaryBaseline, { ...common, sourceScore: row.legacySourceScore }),
      strongComparatorScore: predictEvoContinuousModel(input.models.strongComparator, { ...common, sourceScore: 0 }) };
  });
  const maps = { proposed: rankRows(raw.map((row) => ({ taskId: row.taskId, score: row.proposedScore }))),
    primary: rankRows(raw.map((row) => ({ taskId: row.taskId, score: row.primaryBaselineScore }))),
    strong: rankRows(raw.map((row) => ({ taskId: row.taskId, score: row.strongComparatorScore }))) };
  const rows: FreshPolicyRow[] = raw.map((row) => ({ ...row, proposedRank: maps.proposed.get(row.taskId)!,
    primaryBaselineRank: maps.primary.get(row.taskId)!, strongComparatorRank: maps.strong.get(row.taskId)! }));
  const objects = Object.fromEntries(FRESH_PRIORITY_COVERAGES.map((coverage) => {
    const count = Math.max(1, Math.min(FRESH_N, roundHalfUp(coverage * FRESH_N)));
    return [String(Math.round(coverage * 100)), { acceptedCount: count, proposed: accepted(rows, "proposedScore", count),
      primaryBaseline: accepted(rows, "primaryBaselineScore", count), strongComparator: accepted(rows, "strongComparatorScore", count) }];
  })) as unknown as FreshPolicyFreezeBody["priorityObjects"];
  const counts = Object.fromEntries(Object.entries(objects).map(([key, value]) => [key, value.acceptedCount]));
  // Priority-coverage acceptance counts are mechanically coverage x activePrefixN, rounded half-up:
  //   N=5 -> 0.4:2, 0.6:3, 0.7:4, 0.8:4   (the frozen N=9 contract was 4/5/6/7).
  if (hashCanonical(counts) !== hashCanonical({ 40: 2, 60: 3, 70: 4, 80: 4 })) {
    throw new Error("CORE_DECISION_REQUIRED_FRESH_CAPACITY_CONTRACT_MISMATCH");
  }
  const body: FreshPolicyFreezeBody = { schemaVersion: "direction-a.evo-fresh-n9-pre-y-policy-freeze.v1",
    phase1BarrierHash: input.barrier.contentHash, modelSetHash: input.modelSetHash,
    featureScoringBindingsHash: input.featureScoringBindings.contentHash, executionJournalHeadAtFreeze: journalHead(input.executionEvents),
    executionJournalEventCountAtFreeze: input.executionEvents.length, causalYDispatchCountAtFreeze: 0, rows,
    acceptedCount70: objects["70"].acceptedCount, accepted70: { proposed: objects["70"].proposed,
      primaryBaseline: objects["70"].primaryBaseline, strongComparator: objects["70"].strongComparator }, priorityObjects: objects };
  return immutableCopy({ ...body, contentHash: hashCanonical(body) }) as FreshPolicyFreeze;
}

export function unlockCausalPhase(input: { state: FreshRunState; seal: FreshPolicyFreeze; barrier: FreshAllNormalBarrier;
  exactModelSetHash: string; exactFeatureScoringBindingsHash: string; executionEvents: readonly CurrentFormalExecutionEvent[] }): FreshRunState {
  assertFreshRunState(input.state); assertFreshAllNormalBarrier(input.barrier, input.state.tasks);
  assertHashDocument(input.seal as unknown as { contentHash: string } & Record<string, unknown>, "FRESH_PRE_Y_SEAL");
  assertFreshAuthoritativeExecutionJournal(input.executionEvents);
  if (input.executionEvents.some(isCausalStart) || input.state.phase !== "PHASE2_PRE_Y_FREEZE"
    || input.state.normalBarrierHash !== input.barrier.contentHash || input.seal.phase1BarrierHash !== input.barrier.contentHash
    || input.seal.modelSetHash !== input.exactModelSetHash || input.seal.featureScoringBindingsHash !== input.exactFeatureScoringBindingsHash
    || input.seal.executionJournalHeadAtFreeze !== journalHead(input.executionEvents)
    || input.seal.executionJournalEventCountAtFreeze !== input.executionEvents.length || input.seal.causalYDispatchCountAtFreeze !== 0) {
    throw new Error("FRESH_PHASE3_EXACT_SEAL_UNLOCK_MISMATCH");
  }
  const { contentHash: _oldHash, ...body } = input.state;
  return sealFreshRunState({ ...body, phase: "PHASE3_CAUSAL_Y", preYSealHash: input.seal.contentHash,
    sealedModelSetHash: input.exactModelSetHash, sealedFeatureScoringBindingsHash: input.exactFeatureScoringBindingsHash });
}

export function assertFreshCausalPhaseResume(input: { state: FreshRunState; seal: FreshPolicyFreeze; barrier: FreshAllNormalBarrier;
  exactModelSetHash: string; exactFeatureScoringBindingsHash: string; executionEvents: readonly CurrentFormalExecutionEvent[] }): void {
  assertFreshRunState(input.state); assertFreshAllNormalBarrier(input.barrier, input.state.tasks);
  assertHashDocument(input.seal as unknown as { contentHash: string } & Record<string, unknown>, "FRESH_PRE_Y_SEAL");
  assertFreshAuthoritativeExecutionJournal(input.executionEvents);
  const frozenHead = input.seal.executionJournalEventCountAtFreeze === 0 ? "GENESIS"
    : input.executionEvents[input.seal.executionJournalEventCountAtFreeze - 1]?.eventHash;
  if (input.state.phase !== "PHASE3_CAUSAL_Y" || input.state.normalBarrierHash !== input.barrier.contentHash
    || input.state.preYSealHash !== input.seal.contentHash || input.state.sealedModelSetHash !== input.exactModelSetHash
    || input.state.sealedFeatureScoringBindingsHash !== input.exactFeatureScoringBindingsHash
    || input.seal.phase1BarrierHash !== input.barrier.contentHash || input.seal.modelSetHash !== input.exactModelSetHash
    || input.seal.featureScoringBindingsHash !== input.exactFeatureScoringBindingsHash
    || input.executionEvents.length < input.seal.executionJournalEventCountAtFreeze
    || frozenHead !== input.seal.executionJournalHeadAtFreeze) throw new Error("FRESH_PHASE3_RESUME_SEAL_OR_JOURNAL_DRIFT");
}

export function assertFreshBudget(input: FreshBudgetExposure): void {
  projectFreshBudgetExposure(input);
}
