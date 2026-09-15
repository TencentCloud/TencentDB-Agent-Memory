import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hashCanonical, immutableCopy } from "../core/canonical.js";
import { scoreFrozenSource, type FrozenSourceModel } from "../modeling/evo-continuous-adaptation.js";

export interface AcceptedEvoCaseSummary {
  totalCases: number;
  successCount: number;
  failCount: number;
  utility: number;
  strictPass: boolean;
}

export interface EvoNormalProcessEvidence {
  agentSteps: number;
  commandBatches: number;
  editCommands: number;
  testCompileCommands: number;
  revisionsAfterTest: number;
  errorMarkers: number;
  completionTokens: number;
}

export interface FreshScoringByteBinding {
  path: string;
  sha256: string;
}

export interface FreshFeatureScoringBindingSnapshot {
  schemaVersion: "direction-a.evo-fresh-feature-scoring-byte-bindings.v1";
  bindings: Record<string, FreshScoringByteBinding>;
  contentHash: string;
}

export function parseAcceptedEvoCaseSummary(verifierOutput: string): AcceptedEvoCaseSummary {
  const match = /^CASE_SUMMARY total_cases=(\d+) success_count=(\d+) fail_count=(\d+)$/m.exec(verifierOutput);
  if (!match) throw new Error("FRESH_CASE_SUMMARY_MISSING");
  const totalCases = Number(match[1]); const successCount = Number(match[2]); const failCount = Number(match[3]);
  if (totalCases <= 0 || successCount + failCount !== totalCases) throw new Error("FRESH_CASE_SUMMARY_DENOMINATOR_INVALID");
  return immutableCopy({ totalCases, successCount, failCount, utility: successCount / totalCases, strictPass: successCount === totalCases });
}

export function extractEvoNormalProcessEvidence(rawTrajectory: string): EvoNormalProcessEvidence {
  const parsed = JSON.parse(rawTrajectory) as { steps?: Array<Record<string, any>> };
  const agentSteps = (parsed.steps ?? []).filter((step) => step.source === "agent");
  const commands: string[] = []; let completionTokens = 0; let errorMarkers = 0;
  for (const step of agentSteps) {
    completionTokens += Number(step.metrics?.completion_tokens ?? 0);
    for (const call of (step.tool_calls ?? []) as Array<Record<string, any>>) {
      const keystrokes = call.arguments?.keystrokes; if (typeof keystrokes === "string") commands.push(keystrokes);
    }
    errorMarkers += (JSON.stringify(step.observation ?? "").match(/\b(?:fail(?:ed)?|error|exception|exit code [1-9])\b/gi) ?? []).length;
  }
  const edit = /(?:apply_patch|sed\s+-i|perl\s+-pi|tee\s+|cat\s*>|python\S*\s+.*(?:write|open\())/i;
  const testCompile = /(?:\bgo\s+(?:test|build)\b|\bnpm\s+test\b|\bpnpm\s+test\b|\bpytest\b|\bcargo\s+test\b|\bmake(?:\s|$)|\btsc\b|\bvitest\b|\bcmake\b|\bgcc\b)/i;
  const editIndices = commands.map((command, index) => edit.test(command) ? index : -1).filter((index) => index >= 0);
  const testIndices = commands.map((command, index) => testCompile.test(command) ? index : -1).filter((index) => index >= 0);
  const firstTest = testIndices[0] ?? Number.POSITIVE_INFINITY;
  return immutableCopy({ agentSteps: agentSteps.length, commandBatches: commands.length, editCommands: editIndices.length,
    testCompileCommands: testIndices.length, revisionsAfterTest: editIndices.filter((index) => index > firstTest).length,
    errorMarkers, completionTokens });
}

export function imputeFrozenSourceInputs(model: FrozenSourceModel, known: Readonly<Record<string, number>>): Record<string, number> {
  const values: Record<string, number> = {};
  for (const [index, id] of model.featureOrder.entries()) {
    const value = known[id] ?? model.means[index];
    if (!Number.isFinite(value)) throw new Error(`FRESH_SOURCE_INPUT_INVALID:${id}`);
    values[id] = value;
  }
  return immutableCopy(values);
}

export function buildAcceptedEvoSourceInputs(input: { targetRound: number; instruction: string; normal: AcceptedEvoCaseSummary;
  process: EvoNormalProcessEvidence; model: FrozenSourceModel }): Record<string, number> {
  return imputeFrozenSourceInputs(input.model, {
    x0_history_turn_count_log: Math.log1p(input.targetRound - 1),
    x0_query_token_count_log: Math.log1p(Math.ceil(Buffer.byteLength(input.instruction, "utf8") / 4)),
    n_utility: input.normal.utility,
    n_strict_pass: Number(input.normal.strictPass),
    n_completion_tokens_log: Math.log1p(input.process.completionTokens),
  });
}

export function scoreAcceptedEvoSource(input: { targetRound: number; instruction: string; normal: AcceptedEvoCaseSummary;
  process: EvoNormalProcessEvidence; model: FrozenSourceModel }): number {
  return scoreFrozenSource(input.model, buildAcceptedEvoSourceInputs(input));
}

export function buildAcceptedEvoSharedFeatures(input: { targetRound: number; instruction: string; normal: AcceptedEvoCaseSummary;
  process: EvoNormalProcessEvidence }): Record<string, number> {
  return immutableCopy({ shared_target_round_log: Math.log1p(input.targetRound),
    shared_instruction_bytes_log: Math.log1p(Buffer.byteLength(input.instruction, "utf8")),
    shared_normal_utility: input.normal.utility, shared_normal_strict_pass: Number(input.normal.strictPass),
    shared_completion_tokens_log: Math.log1p(input.process.completionTokens) });
}

export function buildAcceptedEvoProcessFeatures(process: EvoNormalProcessEvidence): Record<string, number> {
  return immutableCopy({ process_edit_commands_log: Math.log1p(process.editCommands),
    process_test_compile_commands_log: Math.log1p(process.testCompileCommands),
    process_revision_recovery_log: Math.log1p(process.revisionsAfterTest + process.errorMarkers) });
}

export function assertFreshFeatureScoringByteBindings(workspaceRoot: string, snapshot: FreshFeatureScoringBindingSnapshot): void {
  const { contentHash, ...body } = snapshot;
  if (snapshot.schemaVersion !== "direction-a.evo-fresh-feature-scoring-byte-bindings.v1" || hashCanonical(body) !== contentHash) {
    throw new Error("FRESH_FEATURE_SCORING_BINDING_HASH_MISMATCH");
  }
  const required = ["proposedModel", "primaryBaseline", "strongComparator", "featureContract", "preprocessing",
    "sourceScoreImplementation", "predictorImplementation", "trainingBank", "modelSet"];
  if (required.some((key) => !snapshot.bindings[key])) throw new Error("FRESH_FEATURE_SCORING_REQUIRED_BINDING_MISSING");
  for (const [key, binding] of Object.entries(snapshot.bindings)) {
    const absolute = resolve(workspaceRoot, binding.path);
    if (!existsSync(absolute)) throw new Error(`FRESH_FEATURE_SCORING_BINDING_ABSENT:${key}`);
    const actual = createHash("sha256").update(readFileSync(absolute)).digest("hex");
    if (actual !== binding.sha256) throw new Error(`FRESH_FEATURE_SCORING_BYTE_DRIFT:${key}`);
  }
}
