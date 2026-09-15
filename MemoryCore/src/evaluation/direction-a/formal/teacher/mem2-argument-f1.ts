import { canonicalJson, hashCanonical } from "../core/canonical.js";
import { createGradedOutcome } from "./graded.js";

export const MEM2_ARGUMENT_F1_POLICY_ID = "mem2.top-level-typed-key-value-f1" as const;
export const MEM2_ARGUMENT_F1_POLICY_VERSION = "1A.v1" as const;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface Mem2ToolCall { tool: string; arguments: Record<string, JsonValue> }

export function canonicalTypedValue(value: JsonValue): string {
  return `${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}:${canonicalJson(value)}`;
}

export function gradeMem2ToolCall(input: { verifierId: string; verifierVersion: string; gold: Mem2ToolCall; predicted: Mem2ToolCall }): {
  outcome: ReturnType<typeof createGradedOutcome>;
  detail: { policyId: typeof MEM2_ARGUMENT_F1_POLICY_ID; policyVersion: typeof MEM2_ARGUMENT_F1_POLICY_VERSION; toolCorrect: boolean; tp: number; fp: number; fn: number; precision: number; recall: number; f1: number };
  graderProvenanceHash: string;
} {
  const toolCorrect = input.gold.tool === input.predicted.tool;
  const goldPairs = Object.entries(input.gold.arguments).map(([key, value]) => `${canonicalJson(key)}\0${canonicalTypedValue(value)}`);
  const predictedPairs = Object.entries(input.predicted.arguments).map(([key, value]) => `${canonicalJson(key)}\0${canonicalTypedValue(value)}`);
  const goldSet = new Set(goldPairs); const predictedSet = new Set(predictedPairs);
  const tp = toolCorrect ? [...predictedSet].filter((pair) => goldSet.has(pair)).length : 0;
  const fp = toolCorrect ? predictedSet.size - tp : predictedSet.size;
  const fn = toolCorrect ? goldSet.size - tp : goldSet.size;
  const bothEmpty = toolCorrect && goldSet.size === 0 && predictedSet.size === 0;
  const precision = bothEmpty ? 1 : predictedSet.size ? tp / predictedSet.size : 0;
  const recall = bothEmpty ? 1 : goldSet.size ? tp / goldSet.size : 0;
  const f1 = !toolCorrect ? 0 : bothEmpty ? 1 : precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  const detail = { policyId: MEM2_ARGUMENT_F1_POLICY_ID, policyVersion: MEM2_ARGUMENT_F1_POLICY_VERSION, toolCorrect, tp, fp, fn, precision, recall, f1 };
  const graderProvenanceHash = hashCanonical({ policy: detail, semantics: { topLevelUnits: true, recursiveCanonicalObjectEquality: true, arrayOrderSensitive: true,
    scalarTypesDistinct: true, fuzzyMatching: false, recursiveLeafPartialCredit: false, schemaAware: false, setAware: false, numericTolerance: false } });
  const numerator = bothEmpty ? 1 : 2 * tp;
  const denominator = bothEmpty ? 1 : Math.max(1, 2 * tp + fp + fn);
  return { outcome: createGradedOutcome({ verifierId: input.verifierId, verifierVersion: `${input.verifierVersion}+${MEM2_ARGUMENT_F1_POLICY_ID}@${MEM2_ARGUMENT_F1_POLICY_VERSION}`,
    numerator, denominator, utility: f1, strictPass: toolCorrect && tp === goldSet.size && tp === predictedSet.size, detail: { ...detail, graderProvenanceHash } }), detail, graderProvenanceHash };
}
