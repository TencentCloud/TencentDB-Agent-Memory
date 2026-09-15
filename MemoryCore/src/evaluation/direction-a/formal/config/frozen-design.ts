import { CURRENT_FORMAL_PROTOCOL_VERSION, CURRENT_FORMAL_SCHEMA_VERSION } from "../core/contracts.js";
import { hashCanonical, immutableCopy } from "../core/canonical.js";

const V7_1_DECISION_IDS = [
  "CONTINUOUS-CAUSAL-REFERENCE-V1-2026-09-09",
  "CONTINUOUS-CAUSAL-REFERENCE-V1.1-2026-09-09",
  "MEM2-TECHNICAL-INVALID-ANTI-CENSORING-V1-2026-09-09",
  "MEM2-A1-SRSWOR-TWO-LAYER-INFERENCE-V1-2026-09-09",
  "MEM2-A2-STRICT-PREY-FALLBACK-V1-2026-09-09",
  "MEM2-CAL-DEV-ANCHOR-FIXED-SEQUENCE-V1-2026-09-09",
  "MEM2-A1-SCALE-PLANNER-V2-2026-09-09",
] as const;

export const FROZEN_DESIGN_BODY = {
  schemaVersion: "direction-a.frozen-design-binding.v4",
  designVersion: "direction-a.mem2-continuous-reference.v7.1.2026-09-09",
  protocolVersion: CURRENT_FORMAL_PROTOCOL_VERSION,
  authorityDecisionIds: V7_1_DECISION_IDS,
  protocolHash: hashCanonical({
    protocolVersion: CURRENT_FORMAL_PROTOCOL_VERSION,
    artifactSchemaVersion: CURRENT_FORMAL_SCHEMA_VERSION,
  }),
  primaryCausalReference: {
    estimand: "D_gj=U_FULL_gj-U_REMOVE_gj",
    estimator: "thetaHatFixed4=mean(first four valid complete pairs in original pairIndex order)",
    validPairsRequired: 4,
    mem2MaximumPredeclaredPairSlots: 5,
    technicalRetryLimit: 0,
    slot5Trigger: "TRUE_TECHNICAL_INVALIDITY_ONLY",
    unavailableReason: "CONTINUOUS_REFERENCE_UNAVAILABLE_TECHNICAL",
    groupTrainingWeight: 1,
    pairRowsAreIidTrainingExamples: false,
    mem2AndEvoRawTargetsNaivelyPooled: false,
  },
  antiCensoring: {
    decisionId: "MEM2-TECHNICAL-INVALID-ANTI-CENSORING-V1-2026-09-09",
    technicalInvalidScope: "UNOBSERVABLE_INFRASTRUCTURE_OR_INTEGRITY_FAILURE_ONLY",
    scientificActionFailureObservedUtility: 0,
    parserPolicyId: "MEM2_SAME_RAW_DETERMINISTIC_PARSER",
    parserVersion: "1.0.0",
    finishReasonLengthAt8192IsTechnicalInvalidByItself: false,
  },
  primaryFormalMetrics: {
    operationalCoverage: "C=E[A]",
    causalUtility: "V=E[A*theta]",
    causalSelectivityGain: "G=E[(A-C)*theta]",
    pairedDeltaV: "DeltaV=E[(A_Proposed-A_Baseline)*theta]",
  },
  technicalReferenceMissingness: {
    primaryCompleteCaseDeletionAllowed: false,
    qualifiedUnitsRemainInOperationalDenominator: true,
    zVUnavailable: "-A",
    zGUnavailable: "-abs(A-C)",
    zDeltaVUnavailable: "-abs(A_Proposed-A_Baseline)",
    referenceAvailabilityReportingRequired: true,
  },
  cal: {
    componentOneSidedAlpha: 0.05,
    iutRequiredComponents: ["V_GT_0", "G_GT_0"],
    splitAlphaPoint025: false,
    candidateGovernance: "DEV_ONLY_MIN_A1_N_ANCHOR_THEN_HIGHER_COVERAGE_ASCENDING_STOP_FIRST_V_G_FAIL",
    coverageAndIndependentClusterSupportFloorsRequired: true,
  },
  sealedTest: {
    absoluteRequiredComponents: ["V_PROPOSED_GT_0", "G_PROPOSED_GT_0"],
    comparativeRequiredComponent: "PAIRED_DELTA_V_GT_0_WITH_CLUSTER_AWARE_95_SUPPORT",
    deltaGPrimaryGate: false,
  },
  clusterIdentity: {
    mem2: "SHARED_SESSION_CONNECTED_COMPONENT",
    evo: "COMPLETE_STATEFUL_TASK_OR_REQUIREMENT_CHAIN",
    groupRowsCountAsIndependentN: false,
  },
  continuousClusterInference: {
    status: "MEM2_A1_FROZEN_ACTIVE_EVO_FUTURE_RESEARCH_QUALIFICATION_REQUIRED",
    mem2: { method: "A1_TWO_LAYER_BOUNDED_FIXED_TIME", sampling: "FIXED_N_SRSWOR",
      coverageSource: "COMPLETE_FROZEN_PREDICTION_POPULATION", pairIidRequired: false,
      pairAssumption: "CONDITIONAL_MEAN_STABILITY", alphaGrid: "001_TO_049_PRE_SAMPLING",
      a2: "STRICT_PRE_Y_TRIGGER_ONLY_NOT_ACTIVE", planner: "A1_SCALE_PLANNER_V2" },
    evo: { status: "FUTURE_RESEARCH_QUALIFICATION_REQUIRED" },
    candidateFamilyIds: [
      "NULL_IMPOSED_WILD_CLUSTER_BOOTSTRAP_T_WEBB_6_POINT",
      "CR2_SATTERTHWAITE",
    ],
    sensitivityOnly: "ONE_CANONICAL_UNIT_PER_CLUSTER_BOUNDED_SENSITIVITY",
    freshCalOrSealedTestRevealAllowedBeforeWinnerFreeze: false,
  },
  planningAssurance: 0.80,
  mem2TotalHardCapCny: 30,
  frozenMem2LowProfile: {
    provider: "DeepSeek",
    model: "DeepSeek V4-Pro",
    reasoning: "low",
    maxOutputTokens: 8192,
    timeoutMs: 300000,
    sdkRetry: 0,
    technicalRetry: 0,
  },
  // Retained only because the historical Evo Pilot/Q6 replay code still consumes these fields.
  evoPilot: { startIndependentTaskClusters: 6, hardMaximumIndependentTaskClusters: 8 },
  pilotAbsoluteCapCny: 80,
  structuralFreshTaskFloors: { cal: 5, sealedTest: 5 },
  q6PrePilotExactDomainSealRequired: true,
  teacherCandidateFamilyIds: ["EMPIRICAL_BERNSTEIN_STITCHED_V1", "BETTING_BOUNDED_MEAN_MIXTURE_V1"],
  permissionContractVersion: "direction-a.permission-firewall.v2",
  claimBoundaryVersion: "direction-a.claim-edges.non-transitive.v2",
  q8PurposeFirewallVersion: "direction-a.q8-purpose-firewall.v1",
  historicalDiagnosticOnly: {
    primaryCausalRiskAlpha: 0.20,
    perGroupCategoricalGold: true,
    perGroupBcsEpsilonRMax: true,
    binaryMcNemarDurkalskiPrimaryTest: true,
    resolvedOnlyDenominator: true,
  },
  postPilotParametersRemainPending: [
    "EVO_CONTINUOUS_CLUSTER_INFERENCE_WINNER_AND_EXACT_SELECTION_RULE",
    "M0_M4_CONTINUOUS_WINNER", "FINAL_Q3_NUMERIC_QUALIFICATION", "FINAL_FEATURE_REGISTRY",
    "FORMAL_MAIN_N", "FORMAL_MAIN_BUDGET", "B2_SPECIFIC_CONTINUOUS_REFERENCE_PLAN",
  ],
} as const;

export type FrozenDesignBody = typeof FROZEN_DESIGN_BODY;
export interface FrozenDesignBinding extends FrozenDesignBody { contentHash: string }

export const FROZEN_DESIGN_BINDING: Readonly<FrozenDesignBinding> = immutableCopy({
  ...FROZEN_DESIGN_BODY,
  contentHash: hashCanonical(FROZEN_DESIGN_BODY),
});

export function assertFrozenDesignBinding(value: FrozenDesignBinding): void {
  const { contentHash, ...body } = value;
  if (hashCanonical(body) !== contentHash) throw new Error("Frozen Design Binding content hash mismatch");
  if (hashCanonical(body) !== FROZEN_DESIGN_BINDING.contentHash) throw new Error("Frozen Design Binding differs from current authority");
}
