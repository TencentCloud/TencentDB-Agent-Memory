import { hashCanonical, immutableCopy } from "../core/canonical.js";
import { assertA1Report, type A1Report, type A1Metric } from "./mem2-a1.js";

export const CONTINUOUS_AGGREGATE_SCHEMA_VERSION = "direction-a.continuous-aggregate.v1" as const;

export interface ContinuousEvaluationUnit {
  causalGroupId: string;
  statisticalClusterId: string;
  proposedAccepted: boolean;
  baselineAccepted: boolean;
  referenceAvailable: boolean;
  thetaHatFixed4: number | null;
  technicalUnavailableReason?: "CONTINUOUS_REFERENCE_UNAVAILABLE_TECHNICAL";
  scientificActionFailureCount: number;
  trueTechnicalInvalidCount: number;
}

export interface ContinuousUnitContribution {
  causalGroupId: string;
  statisticalClusterId: string;
  referenceAvailable: boolean;
  proposedAccepted: 0 | 1;
  baselineAccepted: 0 | 1;
  zVProposed: number;
  zGProposed: number;
  zDeltaVProposedVsBaseline: number;
}

export interface ContinuousAggregateReportBody {
  schemaVersion: typeof CONTINUOUS_AGGREGATE_SCHEMA_VERSION;
  operationalDenominator: number;
  referenceAvailableCount: number;
  referenceAvailabilityRate: number;
  technicalUnavailableCount: number;
  scientificActionFailureCount: number;
  trueTechnicalInvalidCount: number;
  operationalCoverageProposed: number;
  operationalCoverageBaseline: number;
  acceptedSetMeanCausalEffectAvailableOnly: number | null;
  boundedWorstCase: {
    causalUtilityVProposed: number;
    causalSelectivityGProposed: number;
    deltaVProposedVsBaseline: number;
  };
  contributions: ContinuousUnitContribution[];
  clusters: Array<{
    statisticalClusterId: string;
    groupCount: number;
    referenceAvailableCount: number;
    meanZVProposed: number;
    meanZGProposed: number;
    meanZDeltaV: number;
  }>;
  inferenceUnit: "STATISTICAL_CLUSTER";
  groupRowsTreatedAsIidN: false;
}

export type ContinuousAggregateReport = Readonly<ContinuousAggregateReportBody & { contentHash: string }>;

const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

function assertUnit(unit: ContinuousEvaluationUnit): void {
  if (!unit.causalGroupId || !unit.statisticalClusterId) throw new Error("CONTINUOUS_AGGREGATE_UNIT_IDENTITY_REQUIRED");
  if (!Number.isInteger(unit.scientificActionFailureCount) || unit.scientificActionFailureCount < 0
    || !Number.isInteger(unit.trueTechnicalInvalidCount) || unit.trueTechnicalInvalidCount < 0) {
    throw new Error("CONTINUOUS_AGGREGATE_FAILURE_COUNTS_INVALID");
  }
  if (unit.referenceAvailable) {
    if (unit.thetaHatFixed4 === null || !Number.isFinite(unit.thetaHatFixed4)
      || unit.thetaHatFixed4 < -1 || unit.thetaHatFixed4 > 1) throw new Error("CONTINUOUS_AGGREGATE_AVAILABLE_REFERENCE_INVALID");
    if (unit.technicalUnavailableReason) throw new Error("CONTINUOUS_AGGREGATE_AVAILABLE_REFERENCE_HAS_MISSING_REASON");
  } else if (unit.thetaHatFixed4 !== null || unit.technicalUnavailableReason !== "CONTINUOUS_REFERENCE_UNAVAILABLE_TECHNICAL") {
    throw new Error("CONTINUOUS_AGGREGATE_UNAVAILABLE_REFERENCE_INVALID");
  }
}

export function buildContinuousAggregateReport(units: readonly ContinuousEvaluationUnit[]): ContinuousAggregateReport {
  if (!units.length) throw new Error("CONTINUOUS_AGGREGATE_REQUIRES_QUALIFIED_UNITS");
  units.forEach(assertUnit);
  if (new Set(units.map((unit) => unit.causalGroupId)).size !== units.length) throw new Error("CONTINUOUS_AGGREGATE_DUPLICATE_CAUSAL_GROUP");
  const coverageProposed = mean(units.map((unit) => Number(unit.proposedAccepted)));
  const coverageBaseline = mean(units.map((unit) => Number(unit.baselineAccepted)));
  const contributions: ContinuousUnitContribution[] = units.map((unit) => {
    const a = Number(unit.proposedAccepted) as 0 | 1;
    const b = Number(unit.baselineAccepted) as 0 | 1;
    const theta = unit.thetaHatFixed4;
    return {
      causalGroupId: unit.causalGroupId,
      statisticalClusterId: unit.statisticalClusterId,
      referenceAvailable: unit.referenceAvailable,
      proposedAccepted: a,
      baselineAccepted: b,
      zVProposed: unit.referenceAvailable ? a * theta! : -a,
      zGProposed: unit.referenceAvailable ? (a - coverageProposed) * theta! : -Math.abs(a - coverageProposed),
      zDeltaVProposedVsBaseline: unit.referenceAvailable ? (a - b) * theta! : -Math.abs(a - b),
    };
  });
  const clusterIds = [...new Set(units.map((unit) => unit.statisticalClusterId))].sort();
  const clusters = clusterIds.map((statisticalClusterId) => {
    const selected = contributions.filter((row) => row.statisticalClusterId === statisticalClusterId);
    return {
      statisticalClusterId,
      groupCount: selected.length,
      referenceAvailableCount: selected.filter((row) => row.referenceAvailable).length,
      meanZVProposed: mean(selected.map((row) => row.zVProposed)),
      meanZGProposed: mean(selected.map((row) => row.zGProposed)),
      meanZDeltaV: mean(selected.map((row) => row.zDeltaVProposedVsBaseline)),
    };
  });
  const acceptedAvailable = units.filter((unit) => unit.proposedAccepted && unit.referenceAvailable).map((unit) => unit.thetaHatFixed4!);
  const body: ContinuousAggregateReportBody = {
    schemaVersion: CONTINUOUS_AGGREGATE_SCHEMA_VERSION,
    operationalDenominator: units.length,
    referenceAvailableCount: units.filter((unit) => unit.referenceAvailable).length,
    referenceAvailabilityRate: units.filter((unit) => unit.referenceAvailable).length / units.length,
    technicalUnavailableCount: units.filter((unit) => !unit.referenceAvailable).length,
    scientificActionFailureCount: units.reduce((sum, unit) => sum + unit.scientificActionFailureCount, 0),
    trueTechnicalInvalidCount: units.reduce((sum, unit) => sum + unit.trueTechnicalInvalidCount, 0),
    operationalCoverageProposed: coverageProposed,
    operationalCoverageBaseline: coverageBaseline,
    acceptedSetMeanCausalEffectAvailableOnly: acceptedAvailable.length ? mean(acceptedAvailable) : null,
    boundedWorstCase: {
      causalUtilityVProposed: mean(contributions.map((row) => row.zVProposed)),
      causalSelectivityGProposed: mean(contributions.map((row) => row.zGProposed)),
      deltaVProposedVsBaseline: mean(contributions.map((row) => row.zDeltaVProposedVsBaseline)),
    },
    contributions,
    clusters,
    inferenceUnit: "STATISTICAL_CLUSTER",
    groupRowsTreatedAsIidN: false,
  };
  return immutableCopy({ ...body, contentHash: hashCanonical(body) }) as ContinuousAggregateReport;
}

export interface OneSidedComponentTest {
  estimate: number;
  lowerConfidenceBound95: number;
  pValueOneSided: number;
  independentClusterCount: number;
  inferenceProvenance?: { report: A1Report; policyId: string; metric: A1Metric };
}

export function a1ComponentTest(report:A1Report,policyId:string,metric:A1Metric):OneSidedComponentTest {
  assertA1Report(report);
  if(!report.formalConfidenceEvidence)throw new Error("SYNTHETIC_REPORT_NOT_FORMAL_EVIDENCE");
  const test=report.tests[policyId]?.[metric];
  if(!test)throw new Error("A1_TEST_MISSING");
  return immutableCopy({estimate:test.estimate,lowerConfidenceBound95:test.lowerConfidenceBound95,
    // A level-.05 certificate is not an inverted p-value. This conservative test value
    // only records rejection at the frozen level; no finer significance is asserted.
    pValueOneSided:test.pass ? .05 : 1,independentClusterCount:report.sample.n,
    inferenceProvenance:{report,policyId,metric}});
}

function componentPass(test: OneSidedComponentTest): boolean {
  if(!test.inferenceProvenance)throw new Error("BOUND_A1_INFERENCE_PROVENANCE_REQUIRED");
  const {report,policyId,metric}=test.inferenceProvenance;
  assertA1Report(report);
  const expected=report.tests[policyId]?.[metric];
  if(!expected||test.estimate!==expected.estimate||test.lowerConfidenceBound95!==expected.lowerConfidenceBound95
    ||test.independentClusterCount!==report.sample.n||test.pValueOneSided!==(expected.pass ? .05 : 1)
    ||!report.formalConfidenceEvidence)throw new Error("A1_COMPONENT_TEST_DERIVATION_MISMATCH");
  return Number.isFinite(test.estimate) && Number.isFinite(test.lowerConfidenceBound95)
    && Number.isFinite(test.pValueOneSided) && test.pValueOneSided >= 0 && test.pValueOneSided <= 1
    && Number.isInteger(test.independentClusterCount) && test.independentClusterCount > 0
    && test.lowerConfidenceBound95 > 0 && test.pValueOneSided <= 0.05;
}

export function evaluateCalCandidateIut(input: {
  v: OneSidedComponentTest;
  g: OneSidedComponentTest;
  coverage: number;
  minimumCoverage: number;
  independentClusterSupport: number;
  minimumIndependentClusterSupport: number;
}): { status: "CAL_IUT_PASS" | "CAL_IUT_FAIL"; vPass: boolean; gPass: boolean; coveragePass: boolean; supportPass: boolean; componentAlpha: 0.05 } {
  const vPass = componentPass(input.v);
  const gPass = componentPass(input.g);
  const v=input.v.inferenceProvenance!,g=input.g.inferenceProvenance!;
  if(v.metric!=="V"||g.metric!=="G"||v.report.contentHash!==g.report.contentHash||v.policyId!==g.policyId
    ||v.report.population.purpose!=="CAL"||input.coverage!==v.report.population.coverage[v.policyId]
    ||input.independentClusterSupport!==v.report.population.rows.filter(r=>r.decisions[v.policyId]).length)
    throw new Error("CAL_POPULATION_METRIC_PROVENANCE_MISMATCH");
  const coveragePass = input.coverage >= input.minimumCoverage;
  const supportPass = input.independentClusterSupport >= input.minimumIndependentClusterSupport;
  return { status: vPass && gPass && coveragePass && supportPass ? "CAL_IUT_PASS" : "CAL_IUT_FAIL",
    vPass, gPass, coveragePass, supportPass, componentAlpha: 0.05 };
}

export function evaluateSealedTestGate(input: {
  proposedV: OneSidedComponentTest;
  proposedG: OneSidedComponentTest;
  deltaV: OneSidedComponentTest;
}): { absoluteStatus: "ABSOLUTE_PASS" | "ABSOLUTE_FAIL"; strongScientificImprovement: boolean; deltaGPrimaryGate: false } {
  const results=[input.proposedV,input.proposedG,input.deltaV].map(componentPass);
  const provenance=[input.proposedV,input.proposedG,input.deltaV].map(t=>t.inferenceProvenance!);
  if(provenance.some((p,i)=>p.metric!==(["V","G","DeltaV"] as const)[i]||p.policyId!==provenance[0].policyId
    ||p.report.contentHash!==provenance[0].report.contentHash||p.report.population.purpose!=="SEALED_TEST"))
    throw new Error("TEST_PAIRED_SAMPLE_PROVENANCE_MISMATCH");
  return {
    absoluteStatus: results[0] && results[1] ? "ABSOLUTE_PASS" : "ABSOLUTE_FAIL",
    strongScientificImprovement: results[2],
    deltaGPrimaryGate: false,
  };
}

export const CONTINUOUS_CLUSTER_INFERENCE_AUTHORITY_STATUS = immutableCopy({
  status: "MEM2_A1_FROZEN_ACTIVE_EVO_FUTURE_RESEARCH_QUALIFICATION_REQUIRED" as const,
  mem2: "A1_SRSWOR_TWO_LAYER_BOUNDED_INFERENCE_FROZEN_ACTIVE" as const,
  evo: "FUTURE_RESEARCH_QUALIFICATION_REQUIRED" as const,
  candidateFamilyIds: [
    "NULL_IMPOSED_WILD_CLUSTER_BOOTSTRAP_T_WEBB_6_POINT",
    "CR2_SATTERTHWAITE",
  ] as const,
  sensitivityOnly: "ONE_CANONICAL_UNIT_PER_CLUSTER_BOUNDED_SENSITIVITY" as const,
  reason: "Mem2 A1 is frozen. The retained candidate families apply to future Evo qualification only.",
  freshCalOrTestRevealed: false as const,
});
