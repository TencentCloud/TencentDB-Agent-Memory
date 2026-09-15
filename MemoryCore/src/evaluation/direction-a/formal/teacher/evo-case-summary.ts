import { hashCanonical, sha256 } from "../core/canonical.js";
import { createGradedOutcome } from "./graded.js";

export const EVO_CASE_SUMMARY_POLICY_VERSION = "direction-a.evo-case-summary.v1" as const;
export const EVO_BUILD_FAILURE_ANTI_CENSORING_POLICY_VERSION = "direction-a.evo-build-failure-anti-censoring.v1" as const;

export interface EvoCaseSummary { totalCases: number; successCount: number; failCount: number }

export interface EvoCompileFailureEvidence {
  attemptId: string;
  taskId: string;
  causalGroupId: string;
  pairIndex: number;
  arm: "FULL" | "REMOVE";
  verifierSource: string;
  verifierSourceSha256: string;
  rawVerifierOutputSha256: string;
  resultSha256: string;
  infrastructureExceptionPresent: boolean;
}

export function parseEvoCaseSummary(raw: string, frozenTotalCases: number): EvoCaseSummary {
  if (!Number.isInteger(frozenTotalCases) || frozenTotalCases < 1) throw new Error("Frozen Evo denominator must be a positive integer");
  const separator = "(?:[ \\t]+|[ \\t]*\\r?\\n[ \\t]*)";
  const records = [...raw.matchAll(new RegExp(`CASE_SUMMARY${separator}total_cases\\s*=\\s*(\\d+)${separator}success_count\\s*=\\s*(\\d+)${separator}fail_count\\s*=\\s*(\\d+)`, "gim"))];
  if (records.length === 0) throw new Error("Missing CASE_SUMMARY");
  if (records.length !== 1) throw new Error("Conflicting or duplicated CASE_SUMMARY records");
  const summary = { totalCases: Number(records[0][1]), successCount: Number(records[0][2]), failCount: Number(records[0][3]) };
  if (summary.successCount + summary.failCount !== summary.totalCases) throw new Error("CASE_SUMMARY counts do not add to total_cases");
  if (summary.totalCases !== frozenTotalCases) throw new Error(`CASE_SUMMARY denominator changed: expected ${frozenTotalCases}, received ${summary.totalCases}`);
  return summary;
}

function assertCompileFailureFallback(input: {
  verifierId: string;
  verifierVersion: string;
  rawVerifierOutput: string;
  frozenTotalCases: number;
  numericReward?: number;
  compileFailureEvidence?: EvoCompileFailureEvidence;
}): EvoCompileFailureEvidence {
  const evidence = input.compileFailureEvidence;
  if (!evidence) throw new Error("Missing CASE_SUMMARY");
  if (input.verifierId !== "evocodebench-native-case-summary"
    || input.verifierVersion !== EVO_CASE_SUMMARY_POLICY_VERSION) throw new Error("EVO_BUILD_FAILURE_FALLBACK_VERIFIER_IDENTITY_MISMATCH");
  if (!evidence.attemptId || !evidence.taskId || !evidence.causalGroupId
    || !Number.isInteger(evidence.pairIndex) || evidence.pairIndex < 1 || evidence.pairIndex > 4
    || !["FULL", "REMOVE"].includes(evidence.arm)) throw new Error("EVO_BUILD_FAILURE_FALLBACK_ATTEMPT_IDENTITY_INCOMPLETE");
  if (evidence.infrastructureExceptionPresent) throw new Error("EVO_BUILD_FAILURE_FALLBACK_INFRASTRUCTURE_EXCEPTION_PRESENT");
  if (input.numericReward !== 0) throw new Error("EVO_BUILD_FAILURE_FALLBACK_REWARD_CONTRACT_MISMATCH");
  if (sha256(evidence.verifierSource) !== evidence.verifierSourceSha256
    || sha256(input.rawVerifierOutput) !== evidence.rawVerifierOutputSha256
    || !/^[a-f0-9]{64}$/.test(evidence.resultSha256)) throw new Error("EVO_BUILD_FAILURE_FALLBACK_IMMUTABLE_HASH_MISMATCH");
  const outputMarkers = input.rawVerifierOutput.match(/^FAIL: Build failed\r?$/gm) ?? [];
  if (outputMarkers.length !== 1 || /CASE_SUMMARY/i.test(input.rawVerifierOutput)) {
    throw new Error("EVO_BUILD_FAILURE_FALLBACK_OUTPUT_CONTROL_FLOW_MISMATCH");
  }
  const source = evidence.verifierSource.replace(/\r\n/g, "\n");
  const branch = /go build -o "\$BINARY" \.\/cmd\/kvstore 2>&1\nif \[ \$\? -ne 0 \]; then\n\s*echo "FAIL: Build failed"\n\s*mkdir -p \/logs\/verifier\n\s*echo "0\.0" > \/logs\/verifier\/reward\.txt\n\s*exit 0\nfi/;
  const branchMatch = branch.exec(source);
  const summaryIndex = source.indexOf('echo "CASE_SUMMARY total_cases=$TOTAL success_count=$PASS fail_count=$FAIL"');
  if (!branchMatch || summaryIndex < 0 || summaryIndex <= branchMatch.index + branchMatch[0].length) {
    throw new Error("EVO_BUILD_FAILURE_FALLBACK_FROZEN_VERIFIER_CONTROL_FLOW_UNPROVEN");
  }
  return evidence;
}

export function gradeEvoCaseSummary(input: { verifierId: string; verifierVersion: string; rawVerifierOutput: string; frozenTotalCases: number;
  numericReward?: number; compileFailureEvidence?: EvoCompileFailureEvidence }): {
  outcome: ReturnType<typeof createGradedOutcome>; summary: EvoCaseSummary; provenanceHash: string; secondaryNumericReward: number | "UNAVAILABLE";
  classification: "CASE_SUMMARY" | "SCIENTIFIC_FAILURE"; scientificFailureReason?: "COMPILE_FAILURE";
} {
  let summary: EvoCaseSummary;
  try {
    summary = parseEvoCaseSummary(input.rawVerifierOutput, input.frozenTotalCases);
  } catch (error) {
    if ((error as Error).message !== "Missing CASE_SUMMARY") throw error;
    const evidence = assertCompileFailureFallback(input);
    summary = { totalCases: input.frozenTotalCases, successCount: 0, failCount: input.frozenTotalCases };
    const provenanceHash = hashCanonical({ policyVersion: EVO_BUILD_FAILURE_ANTI_CENSORING_POLICY_VERSION,
      scientificFailureReason: "COMPILE_FAILURE", frozenTotalCases: input.frozenTotalCases, summary,
      attemptIdentity: { attemptId: evidence.attemptId, taskId: evidence.taskId, causalGroupId: evidence.causalGroupId,
        pairIndex: evidence.pairIndex, arm: evidence.arm }, verifierSourceSha256: evidence.verifierSourceSha256,
      rawVerifierOutputSha256: evidence.rawVerifierOutputSha256, resultSha256: evidence.resultSha256 });
    return { summary, provenanceHash, secondaryNumericReward: input.numericReward ?? "UNAVAILABLE", classification: "SCIENTIFIC_FAILURE",
      scientificFailureReason: "COMPILE_FAILURE", outcome: createGradedOutcome({ verifierId: input.verifierId,
        verifierVersion: `${input.verifierVersion}+${EVO_BUILD_FAILURE_ANTI_CENSORING_POLICY_VERSION}`,
        numerator: 0, denominator: input.frozenTotalCases, utility: 0, strictPass: false,
        detail: { derivedFromObservedBuildFailure: true, rawCaseSummaryFabricated: false, summary, provenanceHash } }) };
  }
  const provenanceHash = hashCanonical({ policyVersion: EVO_CASE_SUMMARY_POLICY_VERSION, frozenTotalCases: input.frozenTotalCases, summary });
  return { summary, provenanceHash, secondaryNumericReward: input.numericReward ?? "UNAVAILABLE", classification: "CASE_SUMMARY", outcome: createGradedOutcome({ verifierId: input.verifierId,
    verifierVersion: `${input.verifierVersion}+${EVO_CASE_SUMMARY_POLICY_VERSION}`, numerator: summary.successCount, denominator: summary.totalCases,
    utility: summary.successCount / summary.totalCases, strictPass: summary.successCount === summary.totalCases, detail: { summary, provenanceHash } }) };
}
