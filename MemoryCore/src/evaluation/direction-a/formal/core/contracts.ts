export const CURRENT_FORMAL_SCHEMA_VERSION = "direction-a.current-formal.v1" as const;
export const CURRENT_FORMAL_PROTOCOL_VERSION = "direction-a.current-formal.protocol.v1" as const;

declare const causalGroupBrand: unique symbol;
declare const causalRowBrand: unique symbol;
declare const statisticalClusterBrand: unique symbol;
export type CausalGroupId = string & { readonly [causalGroupBrand]: true };
export type CausalRowId = string & { readonly [causalRowBrand]: true };
export type StatisticalClusterId = string & { readonly [statisticalClusterBrand]: true };
export const causalGroupId = (value: string): CausalGroupId => requireIdentity(value, "causalGroupId") as CausalGroupId;
export const causalRowId = (value: string): CausalRowId => requireIdentity(value, "causalRowId") as CausalRowId;
export const statisticalClusterId = (value: string): StatisticalClusterId => requireIdentity(value, "statisticalClusterId") as StatisticalClusterId;

function requireIdentity(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must be non-empty`);
  return value;
}

export type ExperimentProgram =
  | "HISTORICAL_FEASIBILITY_AND_FAILURE_ANALYSIS"
  | "CURRENT_FORMAL_PILOT"
  | "CURRENT_FORMAL_MAIN";

export type DataPermission = "PILOT_TRAIN_DEV" | "CAL" | "SEALED_TEST" | "TRANSPORT_TARGET";
export type ClusterKind = "MEM2_COMPONENT" | "EVO_TASK_CHAIN";
export type PilotId =
  | "P-Q1-A"
  | "P-Q2-A"
  | "P-Q2-B"
  | "P-Q2-C"
  | "P-Q3-A"
  | "P-Q5-A"
  | "P-Q6-A"
  | "P-Q6-B"
  | "P-Q7-E-CAL-STAT"
  | "P-Q7-E-TEST-STAT"
  | "P-Q8-B0"
  | "P-Q8-B1"
  | "P-Q8-B2";

export type CoreDecisionGate =
  | "CDR-ESTIMAND"
  | "CDR-GROUPING"
  | "CDR-TEACHER"
  | "CDR-REPLICATION"
  | "CDR-FEATURE"
  | "CDR-QUALIFICATION"
  | "CDR-MODEL"
  | "CDR-U2"
  | "CDR-EXTERNAL-TARGET"
  | "CDR-Q7-E"
  | "CDR-Q7-F"
  | "CDR-DATA-LEAKAGE"
  | "CDR-INSUFFICIENT-CLUSTERS"
  | "CDR-PAID-RUN"
  | "CDR-PROVIDER-MODEL"
  | "CDR-BUDGET-EXPANSION"
  | "CDR-SOURCE-CONTRADICTION";

export interface ClusterIdentity {
  environmentId: string;
  kind: ClusterKind;
  clusterId: string;
  memberIds: string[];
}

export interface CausalQuestionManifest {
  schemaVersion: typeof CURRENT_FORMAL_SCHEMA_VERSION;
  experimentProgram: "CURRENT_FORMAL_PILOT" | "CURRENT_FORMAL_MAIN";
  environmentId: string;
  estimandId: string;
  taskAgentId: string;
  providerId: string;
  modelId: string;
  decodingProfileId: string;
  scaffoldId: string;
  verifierId: string;
  verifierVersion: string;
  accessPolicyId: string;
  horizonId: string;
  targetGroupVersion: string;
  measurementContractHash: string;
}

export interface NormalRunRecord {
  schemaVersion: typeof CURRENT_FORMAL_SCHEMA_VERSION;
  recordId: string;
  permission: DataPermission;
  environmentId: string;
  statisticalClusterId: StatisticalClusterId;
  causalGroupId: CausalGroupId;
  causalRowId: CausalRowId;
  protocolHash: string;
  frozenStateHash: string;
  recallSnapshotHash: string;
  featureSnapshotHash: string;
  trajectoryHash: string;
  costRecordIds: string[];
  createdAt: string;
}

export type CausalArm = "FULL" | "REMOVE";
export type AttemptValidity = "VALID" | "TECHNICAL_INVALID" | "INTEGRITY_INVALID";

export type ScientificActionFailureReason =
  | "PLAIN_TEXT_NO_ACTION"
  | "NO_TOOL_CALL"
  | "MALFORMED_OR_SCHEMA_INVALID_ACTION"
  | "MISSING_ACTION_NAME_OR_ARGUMENTS"
  | "REFUSAL"
  | "EMPTY_SUCCESSFUL_RESPONSE"
  | "WRONG_TOOL"
  | "WRONG_ARGUMENTS"
  | "TOOL_ACTION_FAILURE"
  | "NO_PROGRESS_OR_TASK_FAILURE"
  | "FROZEN_HORIZON_EXHAUSTED_WITHOUT_ACTION"
  | "OUTPUT_LENGTH_8192_WITHOUT_ACTION";

export interface ScientificActionFailureClassification {
  classification: "SCIENTIFIC_ACTION_FAILURE";
  reason: ScientificActionFailureReason;
  parserPolicyId: "MEM2_SAME_RAW_DETERMINISTIC_PARSER";
  parserVersion: "1.0.0";
  utility: 0;
}

export type TechnicalInvalidReason =
  | "PROVIDER_NETWORK_INFRASTRUCTURE_FAILURE"
  | "HARNESS_INFRASTRUCTURE_FAILURE"
  | "ADAPTER_SCHEMA_TRANSPORT_FAILURE"
  | "CORRUPTED_WORKSPACE_RESTORE"
  | "VERIFIER_INFRASTRUCTURE_UNAVAILABLE"
  | "ATTEMPT_INTEGRITY_FAILURE";

export interface GradedOutcome {
  schemaVersion: typeof CURRENT_FORMAL_SCHEMA_VERSION;
  verifierId: string;
  verifierVersion: string;
  numerator: number;
  denominator: number;
  utility: number;
  strictPass: boolean;
  detailHash: string;
}

export interface CausalArmAttempt {
  schemaVersion: typeof CURRENT_FORMAL_SCHEMA_VERSION;
  attemptId: string;
  pairId: string;
  pairIndex: number;
  arm: CausalArm;
  permission: "PILOT_TRAIN_DEV";
  causalQuestionId: string;
  protocolHash: string;
  statisticalClusterId: StatisticalClusterId;
  taskId?: string;
  causalGroupId: CausalGroupId;
  causalRowId: CausalRowId;
  frozenStateHash: string;
  rawTrajectoryHash: string;
  rawCompletionHash: string;
  validity: AttemptValidity;
  invalidReason?: TechnicalInvalidReason | "INTEGRITY_ATTESTATION_MISMATCH";
  outcome?: GradedOutcome;
  scientificActionFailure?: ScientificActionFailureClassification;
  costRecordIds: string[];
  createdAt: string;
}

export interface CausalPairRecord {
  schemaVersion: typeof CURRENT_FORMAL_SCHEMA_VERSION;
  pairId: string;
  pairIndex: number;
  permission: "PILOT_TRAIN_DEV";
  causalQuestionId: string;
  protocolHash: string;
  statisticalClusterId: StatisticalClusterId;
  causalGroupId: CausalGroupId;
  causalRowId: CausalRowId;
  fullAttemptId: string;
  removeAttemptId: string;
  fullUtility: number;
  removeUtility: number;
  difference: number;
  strictPattern: "10" | "11" | "00" | "01";
}

export type TeacherStatus =
  | "POSITIVE"
  | "HARMFUL"
  | "NON_POSITIVE"
  | "NEEDS_MORE"
  | "INCONCLUSIVE_FINAL"
  | "TECHNICAL_INVALID"
  | "TEACHER_METRIC_CONFLICT";

export interface TeacherResolution {
  status: TeacherStatus;
  pairsUsed: number;
  meanDifference: number | "UNAVAILABLE";
  boundId: string | "UNCONFIGURED";
  rationale: string;
}

export type FeatureDisposition =
  | "SHARED_CANDIDATE"
  | "EVO_SPECIFIC_CANDIDATE"
  | "DIAGNOSTIC_ONLY"
  | "DROP_CANDIDATE";

export interface FeatureRegistryEntry {
  featureId: string;
  version: string;
  disposition: FeatureDisposition;
  environments: string[];
  source: "X0" | "DETERMINISTIC_X_PLUS" | "BOUNDED_LLM_X_PLUS";
  availableOnline: boolean;
  readsCausalOutcome: false;
  marginalCostLedgerKey?: string;
  missingSemantics: "UNAVAILABLE" | "NOT_APPLICABLE";
}

export type CostBook =
  | "RESEARCH_BUILD"
  | "MARGINAL_ASSESSMENT"
  | "FULL_CAUSAL_AUDIT"
  | "NORMAL_BASELINE_EXECUTION"
  | "TARGET_ADAPTATION";

export interface CostLedgerEntry {
  schemaVersion: typeof CURRENT_FORMAL_SCHEMA_VERSION;
  recordId: string;
  pilotId?: PilotId;
  book: CostBook;
  environmentId?: string;
  clusterId?: string;
  rowId?: string;
  attemptId?: string;
  providerId?: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  amountCny?: number;
  amountUsd?: number;
  status: "OBSERVED" | "ESTIMATED" | "UNAVAILABLE";
  reason?: string;
  createdAt: string;
}

export interface ArtifactEnvelope<T> {
  schemaVersion: typeof CURRENT_FORMAL_SCHEMA_VERSION;
  artifactKind: string;
  artifactId: string;
  experimentProgram: ExperimentProgram;
  permission: DataPermission;
  protocolHash: string;
  parentHashes: string[];
  createdAt: string;
  payloadHash: string;
  payload: T;
}

export interface PilotRegistryEntry {
  id: PilotId;
  question: string;
  name: string;
  status: "REGISTERED" | "CONDITIONAL_REGISTERED";
  newCausalY: string;
  dependsOn: string[];
  researcherFreezeAfter: string[];
}

export type UnresolvedExecutionField = "UNRESOLVED";

export interface RealPilotExecutionManifest {
  schemaVersion: "direction-a.current-formal.real-execution-manifest.v1";
  experimentProgram: "CURRENT_FORMAL_PILOT";
  status: "NOT_EXECUTABLE";
  taskAgentModelFamily: "DeepSeek V4 Pro";
  providerId: "deepseek";
  providerModelId: "deepseek-v4-pro";
  environmentModelAliases: {
    mem2Standalone: "deepseek-v4-pro";
    evoHarbor: "deepseek/deepseek-v4-pro";
  };
  scaffolds: {
    mem2: "STANDALONE_ONE_SHOT";
    evo: "HARBOR_TERMINUS_2_PINNED";
  };
  decodingProfile: UnresolvedExecutionField;
  evoMaxTurns: UnresolvedExecutionField;
  maxOutputTokens: UnresolvedExecutionField;
  technicalRetryLimit: UnresolvedExecutionField;
  paidRunAuthorization: "ABSENT";
  historicalNumericDefaultsInherited: false;
}

export interface BudgetAuthorizationManifest {
  schemaVersion: "direction-a.current-formal.budget-authorization.v6";
  authorizationId: string;
  protocolHash: string;
  approvedBy: string;
  approvedAt: string;
  maxPaidCalls: number;
  planningTargetCny: number;
  monetaryLimitSemantics: "PLANNING_SOFT_TARGET_WITH_COMPLETE_GROUP_OVERSHOOT";
  allowCompleteGroupOvershoot: true;
  executionManifestHash: string;
  allowRealAgentCalls: true;
  contentHash: string;
}

export interface FrozenNormalUnit {
  schemaVersion: typeof CURRENT_FORMAL_SCHEMA_VERSION;
  causalGroupId: CausalGroupId;
  causalRowId: CausalRowId;
  statisticalClusterId: StatisticalClusterId;
  taskId?: string;
  environmentId: string;
  permission: "PILOT_TRAIN_DEV";
  protocolHash: string;
  frozenStateHash: string;
  recallSnapshotHash: string;
  targetSpecHash: string;
  normalArtifactHash: string;
}
