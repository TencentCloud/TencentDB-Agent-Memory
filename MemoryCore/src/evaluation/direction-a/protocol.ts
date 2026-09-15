export const DIRECTION_A_PROTOCOL_VERSION = "direction-a.protocol.v1" as const;
export const TRACE_VERSION = "memory-eval.trace.v1" as const;
export const BEHAVIOR_EVIDENCE_VERSION = "behavior-evidence.v1" as const;
export const MEMORY_GROUP_VERSION = "memory-group.v1" as const;
export const TRANSFER_EVAL_VERSION = "transfer-eval.v0" as const;

export type ScoreKind =
  | "VECTOR_SIMILARITY"
  | "FTS_RANK_SCORE"
  | "CLIENT_RRF"
  | "NATIVE_HYBRID_SCORE"
  | "UNAVAILABLE";

export type BudgetDecision =
  | "KEPT"
  | "TRUNCATED"
  | "DROPPED_TOTAL_BUDGET"
  | "DROPPED_OTHER"
  | "BUDGET_DISABLED";

export type PersistenceStatus = "CONFIRMED" | "FAILED" | "NOT_ATTEMPTED" | "UNKNOWN";
export type EvaluationStatus = "AVAILABLE" | "UNAVAILABLE";
export type TrialArm = "FULL" | "REMOVE";
export type AccessPolicy = "AUTO_INJECTION_ONLY" | "AUTO_AND_EXPLICIT_TOOLS";

export interface StableIdentity {
  benchmarkSourceRef?: string;
  transportMessageId?: string;
  conversationMessageId?: string;
  l0StoreRecordId?: string;
  actualL1InputId?: string;
  l1MemoryId?: string;
  parentL1MemoryIds?: string[];
  retrievalCandidateId?: string;
  injectionId?: string;
  actionEventId?: string;
  verifierEventId?: string;
}

export interface RecallCandidate {
  id: string;
  content: string;
  type: string;
  sceneName?: string;
  rawScore?: number;
  scoreKind: ScoreKind;
  fusedRank?: number;
  renderedLine: string;
}

export interface BudgetedRecallCandidate extends RecallCandidate {
  decision: BudgetDecision;
  renderedLineAfterBudget?: string;
  originalRank: number;
}

export interface RecallSnapshot {
  snapshotId: string;
  query: string;
  strategy: string;
  candidates: RecallCandidate[];
  budgetedCandidates: BudgetedRecallCandidate[];
  injectedCandidateIds: string[];
  prependContext?: string;
  appendSystemContext?: string;
  accessPolicy: AccessPolicy;
  memoryToolsGuideIncluded: boolean;
}

export type MemoryGroupRelation = "SINGLETON" | "REDUNDANT_SAME_FACT" | "PREDECLARED_COMPOSITE";
export interface MemoryGroup {
  protocolVersion: typeof MEMORY_GROUP_VERSION;
  groupId: string;
  relation: MemoryGroupRelation;
  candidateIds: string[];
  attributionUnitKey?: string;
  resolution: "RESOLVED" | "UNRESOLVED";
  rationale: string;
}

export interface TargetSpec {
  targetId: string;
  groupId: string;
  candidateIds: string[];
  attributionUnitKey?: string;
  frozenAfterR0: true;
}

export interface FrozenEvaluationState {
  protocolVersion: typeof DIRECTION_A_PROTOCOL_VERSION;
  stateId: string;
  s0: Readonly<Record<string, unknown>>;
  r0: Readonly<RecallSnapshot>;
  targetSpec: Readonly<TargetSpec>;
  frozenAt: string;
}

export interface DirectionATraceEvent<T = Record<string, unknown>> {
  protocolVersion: typeof DIRECTION_A_PROTOCOL_VERSION;
  traceVersion: typeof TRACE_VERSION;
  eventId: string;
  event: string;
  timestamp: string;
  runId: string;
  episodeId: string;
  taskId?: string;
  turnId?: string;
  data: T;
}

export interface CapabilityRecord {
  component: string;
  capability: string;
  status: EvaluationStatus;
  reason?: string;
}

export interface IntegrityCheck {
  check: string;
  passed: boolean;
  details?: string;
}

export interface CostRecord {
  arm?: TrialArm;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  estimatedUsd?: number;
  status: EvaluationStatus;
  reason?: string;
}

