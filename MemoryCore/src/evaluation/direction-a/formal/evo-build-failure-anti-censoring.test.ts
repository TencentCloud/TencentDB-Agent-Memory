import { describe, expect, it } from "vitest";
import { hashCanonical, sha256 } from "./core/canonical.js";
import { EVO_CASE_SUMMARY_POLICY_VERSION, gradeEvoCaseSummary, type EvoCompileFailureEvidence } from "./teacher/evo-case-summary.js";

const verifierSource = `#!/usr/bin/env bash
echo "=== Building kvstore binary ==="
cd /app
go build -o "$BINARY" ./cmd/kvstore 2>&1
if [ $? -ne 0 ]; then
    echo "FAIL: Build failed"
    mkdir -p /logs/verifier
    echo "0.0" > /logs/verifier/reward.txt
    exit 0
fi
echo "Build successful"
echo "CASE_SUMMARY total_cases=$TOTAL success_count=$PASS fail_count=$FAIL"
`;
const buildOutput = "=== Building kvstore binary ===\n# kvstore/engine\nengine/sstable.go:505:6: syntax error\nFAIL: Build failed\n";
const evidence = (overrides: Partial<EvoCompileFailureEvidence> = {}): EvoCompileFailureEvidence => ({
  attemptId: "attempt", taskId: "task", causalGroupId: "group", pairIndex: 2, arm: "REMOVE",
  verifierSource, verifierSourceSha256: sha256(verifierSource), rawVerifierOutputSha256: sha256(buildOutput),
  resultSha256: "a".repeat(64), infrastructureExceptionPresent: false, ...overrides,
});
const grade = (overrides: Record<string, unknown> = {}) => gradeEvoCaseSummary({ verifierId: "evocodebench-native-case-summary",
  verifierVersion: EVO_CASE_SUMMARY_POLICY_VERSION, rawVerifierOutput: buildOutput, frozenTotalCases: 362, numericReward: 0,
  compileFailureEvidence: evidence(), ...overrides });

describe("Evo build-failure anti-censoring", () => {
  it("preserves the normal CASE_SUMMARY behavior and provenance", () => {
    const raw = "CASE_SUMMARY total_cases=4 success_count=3 fail_count=1";
    const graded = gradeEvoCaseSummary({ verifierId: "v", verifierVersion: "x", rawVerifierOutput: raw, frozenTotalCases: 4, numericReward: 0 });
    expect(graded.classification).toBe("CASE_SUMMARY");
    expect(graded.summary).toEqual({ totalCases: 4, successCount: 3, failCount: 1 });
    expect(graded.outcome.utility).toBe(.75);
    expect(graded.provenanceHash).toBe(hashCanonical({ policyVersion: EVO_CASE_SUMMARY_POLICY_VERSION,
      frozenTotalCases: 4, summary: graded.summary }));
  });

  it("derives a zero-utility scientific compile failure only from the proven frozen branch", () => {
    const graded = grade();
    expect(graded.classification).toBe("SCIENTIFIC_FAILURE");
    expect(graded.scientificFailureReason).toBe("COMPILE_FAILURE");
    expect(graded.outcome).toMatchObject({ numerator: 0, denominator: 362, utility: 0, strictPass: false });
    expect(graded.summary).toEqual({ totalCases: 362, successCount: 0, failCount: 362 });
  });

  it("does not treat reward zero alone as sufficient", () => {
    expect(() => gradeEvoCaseSummary({ verifierId: "evocodebench-native-case-summary", verifierVersion: EVO_CASE_SUMMARY_POLICY_VERSION,
      rawVerifierOutput: "no summary", frozenTotalCases: 362, numericReward: 0 })).toThrow("Missing CASE_SUMMARY");
  });

  it("fails closed for unknown missing-summary output", () => {
    expect(() => grade({ rawVerifierOutput: "FAIL: unknown", compileFailureEvidence: evidence({ rawVerifierOutputSha256: sha256("FAIL: unknown") }) }))
      .toThrow(/OUTPUT_CONTROL_FLOW/);
  });

  it("rejects build-like text when an infrastructure exception is present", () => {
    expect(() => grade({ compileFailureEvidence: evidence({ infrastructureExceptionPresent: true }) })).toThrow(/INFRASTRUCTURE_EXCEPTION/);
  });

  it("keeps duplicated summaries invalid", () => {
    const raw = "CASE_SUMMARY total_cases=4 success_count=0 fail_count=4\nCASE_SUMMARY total_cases=4 success_count=0 fail_count=4";
    expect(() => grade({ rawVerifierOutput: raw, frozenTotalCases: 4 })).toThrow(/Conflicting or duplicated/);
  });

  it("keeps denominator mismatch invalid", () => {
    expect(() => grade({ rawVerifierOutput: "CASE_SUMMARY total_cases=4 success_count=0 fail_count=4" })).toThrow(/denominator changed/);
  });

  it("does not fabricate CASE_SUMMARY into raw verifier bytes", () => {
    const before = buildOutput;
    grade();
    expect(buildOutput).toBe(before);
    expect(buildOutput).not.toContain("CASE_SUMMARY");
  });

  it("fails closed on verifier source or output hash drift", () => {
    expect(() => grade({ compileFailureEvidence: evidence({ verifierSourceSha256: "b".repeat(64) }) })).toThrow(/IMMUTABLE_HASH/);
    expect(() => grade({ compileFailureEvidence: evidence({ rawVerifierOutputSha256: "b".repeat(64) }) })).toThrow(/IMMUTABLE_HASH/);
  });
});
