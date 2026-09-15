import { hashCanonical, immutableCopy } from "../core/canonical.js";
import type { CausalArm, TechnicalInvalidReason } from "../core/contracts.js";

export const TECHNICAL_INVALID_REASONS: readonly TechnicalInvalidReason[] = [
  "PROVIDER_NETWORK_INFRASTRUCTURE_FAILURE",
  "HARNESS_INFRASTRUCTURE_FAILURE",
  "ADAPTER_SCHEMA_TRANSPORT_FAILURE",
  "CORRUPTED_WORKSPACE_RESTORE",
  "VERIFIER_INFRASTRUCTURE_UNAVAILABLE",
  "ATTEMPT_INTEGRITY_FAILURE",
] as const;

export type ScientificOutcomeReason =
  | "NORMAL_HORIZON_EXHAUSTED"
  | "AGENT_NO_EDIT"
  | "AGENT_NO_PROGRESS"
  | "TOOL_CALL_FAILURE"
  | "COMPILE_FAILURE"
  | "TEST_FAILURE"
  | "VALID_VERIFIER_ZERO_OR_LOW_SCORE"
  | "FULL_TASK_FAILURE"
  | "REMOVE_TASK_FAILURE"
  | "PLAIN_TEXT_NO_ACTION"
  | "NO_TOOL_CALL"
  | "MALFORMED_OR_SCHEMA_INVALID_ACTION"
  | "MISSING_ACTION_NAME_OR_ARGUMENTS"
  | "REFUSAL"
  | "EMPTY_SUCCESSFUL_RESPONSE"
  | "WRONG_TOOL"
  | "WRONG_ARGUMENTS"
  | "OUTPUT_LENGTH_8192"
  | "FROZEN_HORIZON_EXHAUSTED";

export const SCIENTIFIC_OUTCOME_REASONS: readonly ScientificOutcomeReason[] = [
  "NORMAL_HORIZON_EXHAUSTED", "AGENT_NO_EDIT", "AGENT_NO_PROGRESS", "TOOL_CALL_FAILURE",
  "COMPILE_FAILURE", "TEST_FAILURE", "VALID_VERIFIER_ZERO_OR_LOW_SCORE", "FULL_TASK_FAILURE", "REMOVE_TASK_FAILURE",
  "PLAIN_TEXT_NO_ACTION", "NO_TOOL_CALL", "MALFORMED_OR_SCHEMA_INVALID_ACTION", "MISSING_ACTION_NAME_OR_ARGUMENTS",
  "REFUSAL", "EMPTY_SUCCESSFUL_RESPONSE", "WRONG_TOOL", "WRONG_ARGUMENTS", "OUTPUT_LENGTH_8192", "FROZEN_HORIZON_EXHAUSTED",
] as const;

export function assertTechnicalInvalidReason(reason: string): asserts reason is TechnicalInvalidReason {
  if ((SCIENTIFIC_OUTCOME_REASONS as readonly string[]).includes(reason)) {
    throw new Error(`ANTI_CENSORING_VIOLATION:${reason} is an observed scientific outcome and cannot be retried as technical invalid`);
  }
  if (!(TECHNICAL_INVALID_REASONS as readonly string[]).includes(reason)) throw new Error(`UNKNOWN_TECHNICAL_INVALID_REASON:${reason}`);
}

export interface PairScheduleRow {
  pairIndex: number;
  scheduledArmOrder: "FULL_FIRST" | "REMOVE_FIRST";
}

export interface PairSchedule {
  schemaVersion: "direction-a.pair-schedule.v1";
  orderSeed: string;
  orderPolicyVersion: "direction-a.counterbalanced-hash-order.v1";
  rows: PairScheduleRow[];
  scheduleHash: string;
}

export function createPairSchedule(pairIndices: readonly number[], orderSeed: string): PairSchedule {
  if (!orderSeed) throw new Error("PairSchedule requires a pre-outcome orderSeed");
  const unique = [...new Set(pairIndices)];
  if (unique.length !== pairIndices.length || unique.some((value) => !Number.isInteger(value) || value < 1)) throw new Error("PairSchedule pairIndex values must be unique positive integers");
  const randomized = unique.map((pairIndex) => ({ pairIndex, key: hashCanonical({ orderSeed, pairIndex, policy: "direction-a.counterbalanced-hash-order.v1" }) }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const extraFull = randomized.length % 2 === 1 && parseInt(hashCanonical({ orderSeed, extra: true }).slice(0, 2), 16) % 2 === 0;
  const fullCount = Math.floor(randomized.length / 2) + (extraFull ? 1 : 0);
  const assignment = new Map(randomized.map((row, index) => [row.pairIndex, index < fullCount ? "FULL_FIRST" as const : "REMOVE_FIRST" as const]));
  const body = {
    schemaVersion: "direction-a.pair-schedule.v1" as const,
    orderSeed,
    orderPolicyVersion: "direction-a.counterbalanced-hash-order.v1" as const,
    rows: [...unique].sort((a, b) => a - b).map((pairIndex) => ({ pairIndex, scheduledArmOrder: assignment.get(pairIndex)! })),
  };
  return immutableCopy({ ...body, scheduleHash: hashCanonical(body) }) as PairSchedule;
}

export function assertPairSchedule(schedule: PairSchedule): void {
  const { scheduleHash, ...body } = schedule;
  if (hashCanonical(body) !== scheduleHash) throw new Error("PAIR_SCHEDULE_HASH_MISMATCH");
  const full = schedule.rows.filter((row) => row.scheduledArmOrder === "FULL_FIRST").length;
  const remove = schedule.rows.length - full;
  if (Math.abs(full - remove) > 1) throw new Error("PAIR_SCHEDULE_NOT_COUNTERBALANCED");
  if (new Set(schedule.rows.map((row) => row.pairIndex)).size !== schedule.rows.length) throw new Error("PAIR_SCHEDULE_DUPLICATE_PAIR_INDEX");
}

export function scheduledArms(schedule: PairSchedule, pairIndex: number): readonly [CausalArm, CausalArm] {
  assertPairSchedule(schedule);
  const row = schedule.rows.find((candidate) => candidate.pairIndex === pairIndex);
  if (!row) throw new Error(`PAIR_NOT_IN_FROZEN_SCHEDULE:${pairIndex}`);
  return row.scheduledArmOrder === "FULL_FIRST" ? ["FULL", "REMOVE"] : ["REMOVE", "FULL"];
}

export function assertActualArmStartOrder(schedule: PairSchedule, pairIndex: number, actualStarts: readonly CausalArm[]): void {
  const expected = scheduledArms(schedule, pairIndex);
  if (!actualStarts.length || actualStarts[0] !== expected[0]) {
    throw new Error(`PAIR_SCHEDULE_ACTUAL_ORDER_MISMATCH:${pairIndex}`);
  }
  const secondStart = actualStarts.findIndex((arm) => arm === expected[1]);
  if (secondStart < 1 || actualStarts.slice(0, secondStart).some((arm) => arm !== expected[0])
    || actualStarts.slice(secondStart).some((arm) => arm !== expected[1])) {
    throw new Error(`PAIR_SCHEDULE_ACTUAL_ORDER_MISMATCH:${pairIndex}`);
  }
}

export interface PairStartJournalEvidence {
  sequence: number;
  eventHash: string;
  attemptId: string;
  taskId: string;
  causalGroupId: string;
  arm: CausalArm;
  pairIndex: number;
}

/** Fail-closed bridge from the authoritative execution journal to the frozen pair schedule. */
export function assertActualArmStartOrderFromJournal(input: {
  schedule: PairSchedule;
  pairIndex: number;
  taskId: string;
  causalGroupId: string;
  starts: readonly PairStartJournalEvidence[];
}): readonly PairStartJournalEvidence[] {
  const starts = [...input.starts].sort((a, b) => a.sequence - b.sequence);
  if (starts.length < 2 || starts.some((row) => row.taskId !== input.taskId || row.causalGroupId !== input.causalGroupId
    || row.pairIndex !== input.pairIndex || !row.eventHash || !row.attemptId || !Number.isInteger(row.sequence))) {
    throw new Error(`PAIR_START_JOURNAL_EVIDENCE_INCOMPLETE:${input.pairIndex}`);
  }
  assertActualArmStartOrder(input.schedule, input.pairIndex, starts.map((row) => row.arm));
  return immutableCopy(starts);
}

export interface AttemptIntegrityAttestationBody {
  schemaVersion: "direction-a.attempt-integrity-attestation.v1";
  attemptId: string;
  restoredStateHash: string;
  frozenStateHash: string;
  environmentSignatureHash: string;
  taskId: string;
  roundId: string;
  causalGroupId: string;
  targetSpecHash: string;
  arm: CausalArm;
  pairScheduleHash: string;
  scheduledArmOrder: PairScheduleRow["scheduledArmOrder"];
  actualArmStartOrdinal: 1 | 2;
  designBindingHash: string;
  q6SealHash: string;
  authorizationHash: string;
  executionProfileHash: string;
  providerId: string;
  modelId: string;
  scaffoldId: string;
  decodingProfileId: string;
  horizonId: string;
  verifierId: string;
  verifierVersion: string;
  accessPolicyId: string;
  guideNormalizationHash: string;
  workspaceIsolationHash: string;
  contextIsolationPass: boolean;
}

export interface AttemptIntegrityAttestation extends AttemptIntegrityAttestationBody { contentHash: string }

export interface JournalBoundAttemptIntegrityAttestation extends AttemptIntegrityAttestation {
  actualStartedArm: CausalArm;
  journalStartEventHash: string;
  journalStartEventSequence: number;
}

export function createAttemptIntegrityAttestation(body: AttemptIntegrityAttestationBody): AttemptIntegrityAttestation {
  if (body.restoredStateHash !== body.frozenStateHash) throw new Error("INTEGRITY_INVALID:RESTORED_STATE_HASH_MISMATCH");
  if (!body.contextIsolationPass || !body.workspaceIsolationHash) throw new Error("INTEGRITY_INVALID:WORKSPACE_OR_CONTEXT_ISOLATION");
  for (const [key, value] of Object.entries(body)) if (value === "") throw new Error(`INTEGRITY_INVALID:EMPTY_${key}`);
  return immutableCopy({ ...body, contentHash: hashCanonical(body) }) as AttemptIntegrityAttestation;
}

export function assertAttemptIntegrityAttestation(attestation: AttemptIntegrityAttestation, expected?: Partial<AttemptIntegrityAttestationBody>): void {
  const { contentHash, ...body } = attestation;
  if (hashCanonical(body) !== contentHash) throw new Error("INTEGRITY_INVALID:ATTESTATION_HASH_MISMATCH");
  if (attestation.restoredStateHash !== attestation.frozenStateHash) throw new Error("INTEGRITY_INVALID:RESTORED_STATE_HASH_MISMATCH");
  if (!attestation.contextIsolationPass) throw new Error("INTEGRITY_INVALID:CONTEXT_ISOLATION");
  if (expected) for (const [key, value] of Object.entries(expected)) {
    if (hashCanonical((attestation as unknown as Record<string, unknown>)[key]) !== hashCanonical(value)) throw new Error(`INTEGRITY_INVALID:${key}_MISMATCH`);
  }
}

export function createJournalBoundAttemptIntegrityAttestation(
  body: AttemptIntegrityAttestationBody,
  start: PairStartJournalEvidence,
): JournalBoundAttemptIntegrityAttestation {
  if (start.attemptId !== body.attemptId || start.taskId !== body.taskId || start.causalGroupId !== body.causalGroupId
    || start.arm !== body.arm || !Number.isInteger(start.sequence) || start.sequence < 1 || !start.eventHash) {
    throw new Error("INTEGRITY_INVALID:JOURNAL_START_BINDING_MISMATCH");
  }
  const expanded = { ...body, actualStartedArm: start.arm, journalStartEventHash: start.eventHash,
    journalStartEventSequence: start.sequence };
  return createAttemptIntegrityAttestation(expanded) as JournalBoundAttemptIntegrityAttestation;
}

export function assertJournalBoundAttemptIntegrityAttestation(attestation: JournalBoundAttemptIntegrityAttestation): void {
  assertAttemptIntegrityAttestation(attestation);
  if (attestation.actualStartedArm !== attestation.arm || !attestation.journalStartEventHash
    || !Number.isInteger(attestation.journalStartEventSequence) || attestation.journalStartEventSequence < 1) {
    throw new Error("INTEGRITY_INVALID:JOURNAL_START_EVIDENCE");
  }
}

export interface ArmInvalidityObservation { arm: CausalArm; validity: "VALID" | "TECHNICAL_INVALID"; technicalReason?: TechnicalInvalidReason }

export interface ArmInvalidityMechanismAudit {
  audited: true;
  protocolDependentArmSpecificMechanismProven: boolean;
  evidenceHash: string;
  rationale: string;
}

export function summarizeTechnicalInvalidity(rows: readonly ArmInvalidityObservation[], mechanismAudit?: ArmInvalidityMechanismAudit): {
  byArm: Record<CausalArm, { attempts: number; technicalInvalid: number; rate: number | "UNAVAILABLE"; reasons: Partial<Record<TechnicalInvalidReason, number>> }>;
  observedCountAsymmetry: boolean;
  status: "ARM_WISE_DIAGNOSTIC_ONLY" | "MEASUREMENT_INTEGRITY_HOLD";
  mechanismAudit: ArmInvalidityMechanismAudit | null;
} {
  const summarize = (arm: CausalArm) => {
    const selected = rows.filter((row) => row.arm === arm);
    const invalid = selected.filter((row) => row.validity === "TECHNICAL_INVALID");
    const reasons: Partial<Record<TechnicalInvalidReason, number>> = {};
    invalid.forEach((row) => { if (!row.technicalReason) throw new Error("Technical-invalid attempt requires a closed reason"); assertTechnicalInvalidReason(row.technicalReason); reasons[row.technicalReason] = (reasons[row.technicalReason] ?? 0) + 1; });
    return { attempts: selected.length, technicalInvalid: invalid.length, rate: selected.length ? invalid.length / selected.length : "UNAVAILABLE" as const, reasons };
  };
  const byArm = { FULL: summarize("FULL"), REMOVE: summarize("REMOVE") };
  const comparable = byArm.FULL.rate !== "UNAVAILABLE" && byArm.REMOVE.rate !== "UNAVAILABLE";
  const observedCountAsymmetry = comparable && byArm.FULL.rate !== byArm.REMOVE.rate;
  const hold = mechanismAudit?.audited === true && mechanismAudit.protocolDependentArmSpecificMechanismProven;
  if (hold && (!mechanismAudit.evidenceHash || !mechanismAudit.rationale)) {
    throw new Error("MEASUREMENT_INTEGRITY_HOLD_REQUIRES_AUDIT_EVIDENCE");
  }
  return { byArm, observedCountAsymmetry,
    status: hold ? "MEASUREMENT_INTEGRITY_HOLD" : "ARM_WISE_DIAGNOSTIC_ONLY",
    mechanismAudit: mechanismAudit ?? null };
}
