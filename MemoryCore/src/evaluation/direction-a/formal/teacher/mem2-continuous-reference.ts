import { hashCanonical, immutableCopy, sha256 } from "../core/canonical.js";
import { createGradedOutcome } from "./graded.js";
import type {
  CausalArm,
  GradedOutcome,
  ScientificActionFailureClassification,
  ScientificActionFailureReason,
  TechnicalInvalidReason,
} from "../core/contracts.js";
import { assertTechnicalInvalidReason } from "../acquisition/integrity.js";

export const MEM2_CONTINUOUS_REFERENCE_SCHEMA_VERSION = "direction-a.mem2-continuous-reference.v1" as const;
export const MEM2_FIXED_VALID_PAIRS_REQUIRED = 4 as const;
export const MEM2_MAX_PREDECLARED_PAIR_SLOTS = 5 as const;
export const MEM2_TECHNICAL_RETRY_LIMIT = 0 as const;
export const MEM2_ANTI_CENSORING_DECISION_ID = "MEM2-TECHNICAL-INVALID-ANTI-CENSORING-V1-2026-09-09" as const;
export const MEM2_SAME_RAW_PARSER_POLICY_ID = "MEM2_SAME_RAW_DETERMINISTIC_PARSER" as const;
export const MEM2_SAME_RAW_PARSER_VERSION = "1.0.0" as const;

export interface Mem2ToolActionEnvelope {
  name: string;
  arguments: Record<string, unknown>;
}

export function isMem2ToolActionEnvelope(value: unknown): value is Mem2ToolActionEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.name === "string" && row.name.trim().length > 0
    && !!row.arguments && typeof row.arguments === "object" && !Array.isArray(row.arguments);
}

export interface SameRawParseResult<T> {
  policyId: typeof MEM2_SAME_RAW_PARSER_POLICY_ID;
  parserVersion: typeof MEM2_SAME_RAW_PARSER_VERSION;
  rawCompletionSha256: string;
  valid: boolean;
  value?: T;
  repairSteps: Array<"TRIM_WHITESPACE" | "STRIP_CODE_FENCE" | "EXTRACT_SYNTACTICALLY_VALID_JSON_OBJECT">;
  invalidReason?: "NO_VALID_ACTION_AFTER_FROZEN_SAME_RAW_PARSER";
  newModelCalls: 0;
}

function stripSingleCodeFence(text: string): string | null {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1] : null;
}

function jsonObjectSubstrings(text: string): string[] {
  const values: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        values.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return values;
}

export function parseMem2ActionSameRaw<T>(rawCompletion: string, validate: (value: unknown) => value is T): SameRawParseResult<T> {
  const rawCompletionSha256 = sha256(Buffer.from(rawCompletion, "utf8"));
  const trimmed = rawCompletion.trim();
  const candidates: Array<{ text: string; steps: SameRawParseResult<T>["repairSteps"] }> = [
    { text: rawCompletion, steps: [] },
  ];
  if (trimmed !== rawCompletion) candidates.push({ text: trimmed, steps: ["TRIM_WHITESPACE"] });
  const unfenced = stripSingleCodeFence(trimmed);
  if (unfenced !== null) candidates.push({ text: unfenced.trim(), steps: ["TRIM_WHITESPACE", "STRIP_CODE_FENCE"] });
  for (const object of jsonObjectSubstrings(rawCompletion)) {
    if (object !== rawCompletion && object !== trimmed && object !== unfenced) {
      candidates.push({ text: object, steps: ["EXTRACT_SYNTACTICALLY_VALID_JSON_OBJECT"] });
    }
  }
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.text)) continue;
    seen.add(candidate.text);
    try {
      const parsed: unknown = JSON.parse(candidate.text);
      if (validate(parsed)) return {
        policyId: MEM2_SAME_RAW_PARSER_POLICY_ID,
        parserVersion: MEM2_SAME_RAW_PARSER_VERSION,
        rawCompletionSha256,
        valid: true,
        value: parsed,
        repairSteps: candidate.steps,
        newModelCalls: 0,
      };
    } catch {
      // Deliberately no quote insertion, trailing-comma repair, or semantic completion.
    }
  }
  return {
    policyId: MEM2_SAME_RAW_PARSER_POLICY_ID,
    parserVersion: MEM2_SAME_RAW_PARSER_VERSION,
    rawCompletionSha256,
    valid: false,
    repairSteps: [],
    invalidReason: "NO_VALID_ACTION_AFTER_FROZEN_SAME_RAW_PARSER",
    newModelCalls: 0,
  };
}

export function scientificActionFailure(reason: ScientificActionFailureReason): ScientificActionFailureClassification {
  return {
    classification: "SCIENTIFIC_ACTION_FAILURE",
    reason,
    parserPolicyId: MEM2_SAME_RAW_PARSER_POLICY_ID,
    parserVersion: MEM2_SAME_RAW_PARSER_VERSION,
    utility: 0,
  };
}

export function createScientificActionFailureOutcome(input: {
  reason: ScientificActionFailureReason;
  verifierId: string;
  verifierVersion: string;
  rawCompletionSha256: string;
}): { classification: ScientificActionFailureClassification; outcome: GradedOutcome } {
  const classification = scientificActionFailure(input.reason);
  const outcome = createGradedOutcome({
    verifierId: input.verifierId,
    verifierVersion: input.verifierVersion,
    numerator: 0,
    denominator: 1,
    utility: 0,
    strictPass: false,
    detail: { ...classification, rawCompletionSha256: input.rawCompletionSha256 },
  });
  return { classification, outcome };
}

export type Mem2ObservedArm = {
  arm: CausalArm;
  observation: "SCIENTIFICALLY_OBSERVED";
  utility: number;
  strictPass: boolean;
  attemptId: string;
  rawCompletionHash: string;
  outcomeHash: string;
  scientificActionFailure?: ScientificActionFailureClassification;
};

export type Mem2TechnicalInvalidArm = {
  arm: CausalArm;
  observation: "TECHNICAL_INVALID";
  technicalReason: TechnicalInvalidReason;
  attemptId: string;
  rawCompletionHash?: string;
};

export type Mem2ReferenceArm = Mem2ObservedArm | Mem2TechnicalInvalidArm;

export interface Mem2ReferencePairSlot {
  pairId: string;
  pairIndex: number;
  full: Mem2ReferenceArm;
  remove: Mem2ReferenceArm;
}

export type Mem2ReferenceNextAction =
  | { action: "ACQUIRE_PAIR_SLOT"; pairIndex: 1 | 2 | 3 | 4 | 5; reason: "PREDECLARED_PRIMARY_SLOT" | "TRUE_TECHNICAL_INVALID_LEFT_FIXED4_INCOMPLETE" }
  | { action: "REFERENCE_COMPLETE" }
  | { action: "REFERENCE_UNAVAILABLE"; reason: "CONTINUOUS_REFERENCE_UNAVAILABLE_TECHNICAL" };

function assertArm(arm: Mem2ReferenceArm, expectedArm: CausalArm): void {
  if (arm.arm !== expectedArm || !arm.attemptId) throw new Error("MEM2_REFERENCE_ARM_IDENTITY_INVALID");
  if (arm.observation === "SCIENTIFICALLY_OBSERVED") {
    if (!Number.isFinite(arm.utility) || arm.utility < 0 || arm.utility > 1 || !arm.outcomeHash || !arm.rawCompletionHash) {
      throw new Error("MEM2_REFERENCE_OBSERVED_ARM_INVALID");
    }
    if (arm.scientificActionFailure && (arm.utility !== 0 || arm.scientificActionFailure.utility !== 0)) {
      throw new Error("MEM2_SCIENTIFIC_ACTION_FAILURE_MUST_HAVE_ZERO_UTILITY");
    }
  } else {
    assertTechnicalInvalidReason(arm.technicalReason);
  }
}

function pairIsObserved(slot: Mem2ReferencePairSlot): boolean {
  return slot.full.observation === "SCIENTIFICALLY_OBSERVED" && slot.remove.observation === "SCIENTIFICALLY_OBSERVED";
}

function assertSlots(slots: readonly Mem2ReferencePairSlot[]): Mem2ReferencePairSlot[] {
  const sorted = [...slots].sort((a, b) => a.pairIndex - b.pairIndex);
  if (sorted.length > MEM2_MAX_PREDECLARED_PAIR_SLOTS || new Set(sorted.map((row) => row.pairIndex)).size !== sorted.length) {
    throw new Error("MEM2_REFERENCE_REFERENCE_PAIR_SLOT_SET_INVALID");
  }
  sorted.forEach((slot, index) => {
    if (slot.pairIndex !== index + 1 || slot.pairIndex > MEM2_MAX_PREDECLARED_PAIR_SLOTS || !slot.pairId) {
      throw new Error("MEM2_REFERENCE_PAIR_SLOTS_MUST_BE_CONTIGUOUS_ORIGINAL_INDICES_1_TO_5");
    }
    assertArm(slot.full, "FULL");
    assertArm(slot.remove, "REMOVE");
  });
  if (sorted.length === 5 && sorted.slice(0, 4).every(pairIsObserved)) {
    throw new Error("MEM2_SLOT5_REQUIRES_TRUE_TECHNICAL_INCOMPLETENESS");
  }
  return sorted;
}

export function nextMem2ReferenceAction(slots: readonly Mem2ReferencePairSlot[]): Mem2ReferenceNextAction {
  const sorted = assertSlots(slots);
  const valid = sorted.filter(pairIsObserved).length;
  if (valid >= MEM2_FIXED_VALID_PAIRS_REQUIRED) return { action: "REFERENCE_COMPLETE" };
  if (sorted.length < 4) return { action: "ACQUIRE_PAIR_SLOT", pairIndex: (sorted.length + 1) as 1 | 2 | 3 | 4,
    reason: "PREDECLARED_PRIMARY_SLOT" };
  if (sorted.length === 4) {
    const hasTrueTechnicalInvalidity = sorted.some((slot) => !pairIsObserved(slot));
    if (!hasTrueTechnicalInvalidity) throw new Error("MEM2_SLOT5_CANNOT_BE_TRIGGERED_BY_OBSERVED_SCIENTIFIC_OUTCOME");
    return { action: "ACQUIRE_PAIR_SLOT", pairIndex: 5, reason: "TRUE_TECHNICAL_INVALID_LEFT_FIXED4_INCOMPLETE" };
  }
  return { action: "REFERENCE_UNAVAILABLE", reason: "CONTINUOUS_REFERENCE_UNAVAILABLE_TECHNICAL" };
}

export interface Mem2ContinuousReferenceArtifactBody {
  schemaVersion: typeof MEM2_CONTINUOUS_REFERENCE_SCHEMA_VERSION;
  decisionIds: readonly ["CONTINUOUS-CAUSAL-REFERENCE-V1.1-2026-09-09", typeof MEM2_ANTI_CENSORING_DECISION_ID];
  causalGroupId: string;
  statisticalClusterId: string;
  originalPairIndices: number[];
  firstFourValidPairIndices: number[];
  pairEffects: Array<{ pairId: string; pairIndex: number; difference: number; fullAttemptId: string; removeAttemptId: string }>;
  thetaHatFixed4: number | null;
  referenceAvailable: boolean;
  unavailableReason: null | "CONTINUOUS_REFERENCE_UNAVAILABLE_TECHNICAL";
  scientificActionFailures: { count: number; byReason: Partial<Record<ScientificActionFailureReason, number>> };
  trueTechnicalInvalids: { count: number; byArm: Record<CausalArm, number>; byReason: Partial<Record<TechnicalInvalidReason, number>> };
  groupTrainingWeight: 1;
  technicalRetryLimit: 0;
  bindings: {
    authorityBindingHash: string;
    protocolHash: string;
    profileHash: string;
    snapshotHash: string;
    parserPolicyId: typeof MEM2_SAME_RAW_PARSER_POLICY_ID;
    parserVersion: typeof MEM2_SAME_RAW_PARSER_VERSION;
    verifierHash: string;
  };
}

export type Mem2ContinuousReferenceArtifact = Readonly<Mem2ContinuousReferenceArtifactBody & { contentHash: string }>;

export function buildMem2ContinuousReferenceArtifact(input: {
  causalGroupId: string;
  statisticalClusterId: string;
  slots: readonly Mem2ReferencePairSlot[];
  protocolHash: string;
  authorityBindingHash: string;
  profileHash: string;
  snapshotHash: string;
  verifierHash: string;
}): Mem2ContinuousReferenceArtifact {
  for (const [key, value] of Object.entries(input).filter(([key]) => key !== "slots")) {
    if (typeof value === "string" && !value.trim()) throw new Error(`MEM2_REFERENCE_EMPTY_${key}`);
  }
  const slots = assertSlots(input.slots);
  const action = nextMem2ReferenceAction(slots);
  if (action.action === "ACQUIRE_PAIR_SLOT") throw new Error("MEM2_REFERENCE_EXECUTION_INCOMPLETE");
  const valid = slots.filter(pairIsObserved);
  const selected = valid.slice(0, MEM2_FIXED_VALID_PAIRS_REQUIRED);
  const pairEffects = selected.map((slot) => ({
    pairId: slot.pairId,
    pairIndex: slot.pairIndex,
    difference: (slot.full as Mem2ObservedArm).utility - (slot.remove as Mem2ObservedArm).utility,
    fullAttemptId: slot.full.attemptId,
    removeAttemptId: slot.remove.attemptId,
  }));
  const scientificByReason: Partial<Record<ScientificActionFailureReason, number>> = {};
  const technicalByReason: Partial<Record<TechnicalInvalidReason, number>> = {};
  const technicalByArm: Record<CausalArm, number> = { FULL: 0, REMOVE: 0 };
  let scientificCount = 0;
  let technicalCount = 0;
  for (const slot of slots) for (const arm of [slot.full, slot.remove]) {
    if (arm.observation === "SCIENTIFICALLY_OBSERVED" && arm.scientificActionFailure) {
      scientificCount += 1;
      const reason = arm.scientificActionFailure.reason;
      scientificByReason[reason] = (scientificByReason[reason] ?? 0) + 1;
    } else if (arm.observation === "TECHNICAL_INVALID") {
      technicalCount += 1;
      technicalByArm[arm.arm] += 1;
      technicalByReason[arm.technicalReason] = (technicalByReason[arm.technicalReason] ?? 0) + 1;
    }
  }
  const referenceAvailable = selected.length === MEM2_FIXED_VALID_PAIRS_REQUIRED;
  const body: Mem2ContinuousReferenceArtifactBody = {
    schemaVersion: MEM2_CONTINUOUS_REFERENCE_SCHEMA_VERSION,
    decisionIds: ["CONTINUOUS-CAUSAL-REFERENCE-V1.1-2026-09-09", MEM2_ANTI_CENSORING_DECISION_ID],
    causalGroupId: input.causalGroupId,
    statisticalClusterId: input.statisticalClusterId,
    originalPairIndices: slots.map((slot) => slot.pairIndex),
    firstFourValidPairIndices: selected.map((slot) => slot.pairIndex),
    pairEffects,
    thetaHatFixed4: referenceAvailable ? pairEffects.reduce((sum, row) => sum + row.difference, 0) / MEM2_FIXED_VALID_PAIRS_REQUIRED : null,
    referenceAvailable,
    unavailableReason: referenceAvailable ? null : "CONTINUOUS_REFERENCE_UNAVAILABLE_TECHNICAL",
    scientificActionFailures: { count: scientificCount, byReason: scientificByReason },
    trueTechnicalInvalids: { count: technicalCount, byArm: technicalByArm, byReason: technicalByReason },
    groupTrainingWeight: 1,
    technicalRetryLimit: MEM2_TECHNICAL_RETRY_LIMIT,
    bindings: {
      authorityBindingHash: input.authorityBindingHash,
      protocolHash: input.protocolHash,
      profileHash: input.profileHash,
      snapshotHash: input.snapshotHash,
      parserPolicyId: MEM2_SAME_RAW_PARSER_POLICY_ID,
      parserVersion: MEM2_SAME_RAW_PARSER_VERSION,
      verifierHash: input.verifierHash,
    },
  };
  return immutableCopy({ ...body, contentHash: hashCanonical(body) }) as Mem2ContinuousReferenceArtifact;
}

export function assertMem2ContinuousReferenceArtifact(value: Mem2ContinuousReferenceArtifact): void {
  const { contentHash, ...body } = value;
  if (hashCanonical(body) !== contentHash) throw new Error("MEM2_CONTINUOUS_REFERENCE_CONTENT_HASH_MISMATCH");
  if (value.groupTrainingWeight !== 1 || value.technicalRetryLimit !== 0) throw new Error("MEM2_CONTINUOUS_REFERENCE_FROZEN_POLICY_DRIFT");
  if (value.referenceAvailable !== (value.firstFourValidPairIndices.length === 4)
    || value.referenceAvailable !== (value.thetaHatFixed4 !== null)) throw new Error("MEM2_CONTINUOUS_REFERENCE_AVAILABILITY_INCONSISTENT");
  if (!value.causalGroupId || !value.statisticalClusterId || value.originalPairIndices.length < 4
    || value.originalPairIndices.length > 5 || value.originalPairIndices.some((n,i) => n !== i+1)
    || value.pairEffects.length !== value.firstFourValidPairIndices.length
    || value.firstFourValidPairIndices.some((n,i) => !value.originalPairIndices.includes(n)
      || i > 0 && n <= value.firstFourValidPairIndices[i-1])
    || value.pairEffects.some((p,i) => p.pairIndex !== value.firstFourValidPairIndices[i]
      || !Number.isFinite(p.difference) || Math.abs(p.difference)>1 || !p.fullAttemptId || !p.removeAttemptId)) {
    throw new Error("MEM2_CONTINUOUS_REFERENCE_FIXED4_PROVENANCE_INVALID");
  }
  if (value.referenceAvailable && value.thetaHatFixed4 !== value.pairEffects.reduce((s,p)=>s+p.difference,0)/4) {
    throw new Error("MEM2_CONTINUOUS_REFERENCE_ESTIMATOR_MISMATCH");
  }
  if (!value.referenceAvailable && (value.originalPairIndices.length!==5
    || value.unavailableReason!=="CONTINUOUS_REFERENCE_UNAVAILABLE_TECHNICAL")) {
    throw new Error("MEM2_CONTINUOUS_REFERENCE_TECHNICAL_COMPLETION_INCOMPLETE");
  }
}
