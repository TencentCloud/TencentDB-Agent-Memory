import { assertFiniteUnitInterval, hashCanonical } from "../core/canonical.js";
import { CURRENT_FORMAL_SCHEMA_VERSION, type GradedOutcome } from "../core/contracts.js";

export interface Mem2ArgumentMatcher<T> {
  policyId: string;
  policyVersion: string;
  matches(expected: T, actual: T): boolean;
}

export interface GradedMatchDetail<T> {
  expected: T[];
  actual: T[];
  matchedExpectedIndices: number[];
  matchedActualIndices: number[];
  precision: number;
  recall: number;
  f1: number;
}

export function gradeMem2Arguments<T>(input: {
  verifierId: string;
  verifierVersion: string;
  expected: readonly T[];
  actual: readonly T[];
  matcher: Mem2ArgumentMatcher<T>;
}): { outcome: GradedOutcome; detail: GradedMatchDetail<T> } {
  if (!input.matcher.policyId || !input.matcher.policyVersion) throw new Error("Mem2 matcher must be explicitly versioned");
  const remainingActual = new Set(input.actual.map((_, index) => index));
  const matchedExpectedIndices: number[] = [];
  const matchedActualIndices: number[] = [];
  input.expected.forEach((expected, expectedIndex) => {
    const actualIndex = [...remainingActual].find((index) => input.matcher.matches(expected, input.actual[index]));
    if (actualIndex === undefined) return;
    remainingActual.delete(actualIndex);
    matchedExpectedIndices.push(expectedIndex);
    matchedActualIndices.push(actualIndex);
  });
  const matched = matchedExpectedIndices.length;
  const precision = input.actual.length === 0 ? (input.expected.length === 0 ? 1 : 0) : matched / input.actual.length;
  const recall = input.expected.length === 0 ? (input.actual.length === 0 ? 1 : 0) : matched / input.expected.length;
  const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
  const detail: GradedMatchDetail<T> = {
    expected: [...input.expected], actual: [...input.actual], matchedExpectedIndices, matchedActualIndices, precision, recall, f1,
  };
  const scoreNumerator = input.expected.length === 0 && input.actual.length === 0 ? 1 : 2 * matched;
  const scoreDenominator = input.expected.length === 0 && input.actual.length === 0 ? 1 : input.expected.length + input.actual.length;
  return {
    outcome: createGradedOutcome({
      verifierId: input.verifierId,
      verifierVersion: `${input.verifierVersion}+${input.matcher.policyId}@${input.matcher.policyVersion}`,
      numerator: scoreNumerator,
      denominator: scoreDenominator,
      utility: f1,
      strictPass: matched === input.expected.length && matched === input.actual.length,
      detail,
    }),
    detail,
  };
}

export function gradeEvoCaseProgress(input: {
  verifierId: string;
  verifierVersion: string;
  passedCaseIds: readonly string[];
  totalCaseIds: readonly string[];
}): GradedOutcome {
  const total = new Set(input.totalCaseIds);
  if (total.size === 0) throw new Error("Evo graded verifier requires a non-empty frozen case denominator");
  const passed = new Set(input.passedCaseIds);
  for (const caseId of passed) if (!total.has(caseId)) throw new Error(`Passed case ${caseId} is outside the frozen denominator`);
  const numerator = passed.size;
  const denominator = total.size;
  return createGradedOutcome({
    verifierId: input.verifierId,
    verifierVersion: input.verifierVersion,
    numerator,
    denominator,
    utility: numerator / denominator,
    strictPass: numerator === denominator,
    detail: { passedCaseIds: [...passed].sort(), totalCaseIds: [...total].sort() },
  });
}

export function createGradedOutcome(input: {
  verifierId: string;
  verifierVersion: string;
  numerator: number;
  denominator: number;
  utility: number;
  strictPass: boolean;
  detail: unknown;
}): GradedOutcome {
  if (!Number.isInteger(input.numerator) || !Number.isInteger(input.denominator) || input.numerator < 0 || input.denominator < 1 || input.numerator > input.denominator) {
    throw new Error("Graded verifier numerator/denominator are invalid");
  }
  assertFiniteUnitInterval(input.utility, "graded utility");
  return {
    schemaVersion: CURRENT_FORMAL_SCHEMA_VERSION,
    verifierId: input.verifierId,
    verifierVersion: input.verifierVersion,
    numerator: input.numerator,
    denominator: input.denominator,
    utility: input.utility,
    strictPass: input.strictPass,
    detailHash: hashCanonical(input.detail),
  };
}

export interface OfflineParseResult<T> {
  rawCompletionHash: string;
  value?: T;
  valid: boolean;
  repairSteps: string[];
  invalidReason?: string;
}

export function parseJsonOffline<T>(rawCompletion: string, validate: (value: unknown) => value is T): OfflineParseResult<T> {
  const rawCompletionHash = hashCanonical(rawCompletion);
  const candidates: Array<{ text: string; repair: string }> = [{ text: rawCompletion.trim(), repair: "NONE" }];
  const first = rawCompletion.indexOf("{");
  const last = rawCompletion.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push({ text: rawCompletion.slice(first, last + 1), repair: "EXTRACT_FIRST_JSON_OBJECT" });
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate.text);
      if (validate(parsed)) return { rawCompletionHash, value: parsed, valid: true, repairSteps: candidate.repair === "NONE" ? [] : [candidate.repair] };
    } catch {
      // The same raw completion may be repaired offline. No new Agent call occurs here.
    }
  }
  return { rawCompletionHash, valid: false, repairSteps: candidates.slice(1).map((candidate) => candidate.repair), invalidReason: "NO_VALID_JSON_FROM_SAME_RAW_COMPLETION" };
}
