import type { BudgetAuthorizationManifest, CausalArm, CausalGroupId, CausalRowId, FrozenNormalUnit, RealPilotExecutionManifest, StatisticalClusterId } from "../core/contracts.js";
import type { AttemptIntegrityAttestation, PairSchedule } from "./integrity.js";

export interface FrozenArmConfig {
  causalGroupId: CausalGroupId;
  causalRowId: CausalRowId;
  statisticalClusterId: StatisticalClusterId;
  pairIndex: number;
  arm: CausalArm;
  protocolHash: string;
  frozenStateHash: string;
  targetSpecHash: string;
  promptHash: string;
  scaffoldConfigHash: string;
}

export interface TaskAgentExecutionRequest { attemptId: string; normalUnit: FrozenNormalUnit; armConfig: FrozenArmConfig }
export interface TaskAgentExecutionResult { rawTrajectory: string; rawCompletion: string; verifierOutput: string; technicalMetadata: Record<string, unknown> }

export interface AcquisitionPlan {
  executionManifest: RealPilotExecutionManifest;
  executionManifestHash: string;
  protocolHash: string;
  normalUnits: FrozenNormalUnit[];
  armConfigs: FrozenArmConfig[];
  authorization?: BudgetAuthorizationManifest;
  pairSchedule?: PairSchedule;
  q6SealHash?: string;
  designBindingHash?: string;
}

export type AttemptJournalEventType = "NORMAL_FROZEN" | "PAIR_SCHEDULE_FROZEN" | "ATTEMPT_STARTED" | "ATTEMPT_NOT_DISPATCHED" | "ATTEMPT_INTEGRITY_ATTESTED" | "RAW_BOUND" | "PARSE_RECORDED" | "ATTEMPT_TECHNICAL_INVALID" | "ATTEMPT_INTEGRITY_INVALID" | "ATTEMPT_SCIENTIFIC_ACTION_FAILURE" | "ATTEMPT_VALID" | "PAIR_COMMITTED"
  | "REFERENCE_SLOT_STARTED" | "REFERENCE_SLOT_BOUND" | "REFERENCE_FROZEN";
export interface AttemptJournalEvent {
  schemaVersion: "direction-a.current-formal.attempt-journal.v1";
  sequence: number;
  eventId: string;
  eventType: AttemptJournalEventType;
  attemptId?: string;
  pairId?: string;
  arm?: CausalArm;
  protocolHash: string;
  armConfigHash?: string;
  rawArtifactHash?: string;
  parserVersion?: string;
  payload: Record<string, unknown>;
  previousEventHash: string | "GENESIS";
  eventHash: string;
}

export interface ResumeState {
  events: AttemptJournalEvent[];
  nextSequence: number;
  startedAttemptIds: Set<string>;
  validAttemptsByPairArm: Map<string, string>;
  rawHashByAttempt: Map<string, string>;
  pairIds: Set<string>;
  frozenNormalUnits: Map<string, FrozenNormalUnit>;
  pairSchedule?: PairSchedule;
  attestationByAttempt: Map<string, AttemptIntegrityAttestation>;
  actualStartsByPair: Map<string, CausalArm[]>;
}
