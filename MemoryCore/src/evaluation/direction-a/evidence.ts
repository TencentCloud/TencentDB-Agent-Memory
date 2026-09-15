import {
  BEHAVIOR_EVIDENCE_VERSION,
  TRANSFER_EVAL_VERSION,
  type CapabilityRecord,
  type CostRecord,
  type EvaluationStatus,
  type IntegrityCheck,
  type TrialArm,
} from "./protocol.js";

export interface E0FactEvidence {
  tier: "E0";
  sourceRef: string;
  fact: string;
  supported: boolean;
}

export interface E1BehaviorEvidence {
  version: typeof BEHAVIOR_EVIDENCE_VERSION;
  tier: "E1";
  actionEventId: string;
  memoryGroupId: string;
  relation: "USED" | "CONTRADICTED" | "CONSISTENT_WITH" | "NO_LINK";
  rationale: string;
}

export interface E2OutcomeEvidence {
  version: typeof BEHAVIOR_EVIDENCE_VERSION;
  tier: "E2";
  verifierEventId: string;
  actionEventIds: string[];
  outcome: "SUCCESS" | "FAILURE" | "PARTIAL" | "UNAVAILABLE";
  score?: number;
  reason?: string;
}

export type BehaviorEvidence = E0FactEvidence | E1BehaviorEvidence | E2OutcomeEvidence;

export interface RevisionPair {
  pairId: string;
  beforeActionEventId: string;
  afterActionEventId: string;
  triggerMemoryGroupIds: string[];
  revisionKind: "CORRECTION" | "REFINEMENT" | "REVERSAL" | "NO_REVISION" | "UNAVAILABLE";
  status: EvaluationStatus;
  reason?: string;
}

export interface LocalActionProbe {
  probeId: string;
  inputEventIds: string[];
  outputKind: "NEXT_ACTION_PROPOSAL";
  proposal?: string;
  toolsEnabled: false;
  networkEnabled: false;
  workspaceEnabled: false;
  status: EvaluationStatus;
  reason?: string;
}

export interface LongitudinalEvidence {
  seriesId: string;
  attributionUnitKey?: string;
  eventIds: string[];
  trend: "IMPROVING" | "DEGRADING" | "STABLE" | "MIXED" | "UNAVAILABLE";
  status: EvaluationStatus;
  reason?: string;
}

export interface TrialOutcome {
  arm: TrialArm;
  status: EvaluationStatus;
  success?: boolean;
  score?: number;
  verifierEventId?: string;
  reason?: string;
  cost: CostRecord;
}

export interface CalibrationBin {
  lowerInclusive: number;
  upperExclusive: number;
  count: number;
  observedSuccessRate?: number;
  status: EvaluationStatus;
}

export interface TransferEvaluation {
  version: typeof TRANSFER_EVAL_VERSION;
  sourceDomain: string;
  targetDomain: string;
  lodoHeldOutDomain?: string;
  attributionUnitKeys: string[];
  metrics: Record<string, number | "UNAVAILABLE">;
  capability: CapabilityRecord[];
  integrity: IntegrityCheck[];
  status: EvaluationStatus;
  reason?: string;
}

export interface EvaluationEpisodeResult {
  episodeId: string;
  evidence: BehaviorEvidence[];
  revisionPairs: RevisionPair[];
  probes: LocalActionProbe[];
  longitudinal: LongitudinalEvidence[];
  trialOutcomes: TrialOutcome[];
  costs: CostRecord[];
  integrity: IntegrityCheck[];
  capabilities: CapabilityRecord[];
}

export function unavailable<T extends object>(record: T, reason: string): T & { status: "UNAVAILABLE"; reason: string } {
  return { ...record, status: "UNAVAILABLE", reason };
}

