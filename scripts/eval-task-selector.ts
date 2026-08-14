#!/usr/bin/env npx tsx

import fs from "node:fs/promises";
import path from "node:path";
import { StandaloneLLMRunnerFactory } from "../src/adapters/standalone/llm-runner.js";
import type { Logger, LLMRunner } from "../src/core/types.js";
import {
  selectTaskAwareMemories,
  type TaskAwareMemoryCandidate,
} from "../src/core/recall/task-aware-selector.js";

interface EvalCandidate extends TaskAwareMemoryCandidate {
  /** 0 = irrelevant, 1 = useful, 2 = critical for the next response. */
  relevance: 0 | 1 | 2;
}

interface EvalCase {
  name: string;
  query: string;
  maxResults: number;
  candidates: EvalCandidate[];
}

interface Scores {
  precisionAtK: number;
  recallAtK: number;
  ndcgAtK: number;
  criticalRecall: number;
}

interface RunResult extends Scores {
  caseName: string;
  run: number;
  baseline: Scores;
  selectedIds: string[];
  fallback: boolean;
  latencyMs: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
}

const DEFAULT_FIXTURE = "evals/task-aware-selector/cases.json";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const fixturePath = path.resolve(args.find((arg) => !arg.startsWith("--")) ?? DEFAULT_FIXTURE);
  const cases = validateCases(JSON.parse(await fs.readFile(fixturePath, "utf8")));

  if (dryRun) {
    const baseline = cases.map((testCase) => ({
      case: testCase.name,
      ...scoreSelection(testCase, testCase.candidates.slice(0, testCase.maxResults)),
    }));
    console.log(`Validated ${cases.length} cases from ${fixturePath}`);
    console.table(baseline.map(formatScoreRow));
    return;
  }

  const baseUrl = requiredEnv("TDAI_EVAL_BASE_URL");
  const apiKey = requiredEnv("TDAI_EVAL_API_KEY");
  const model = requiredEnv("TDAI_EVAL_MODEL");
  const runs = positiveInteger(process.env.TDAI_EVAL_RUNS, 3);
  const timeoutMs = positiveInteger(process.env.TDAI_EVAL_TIMEOUT_MS, 3000);
  const results: RunResult[] = [];

  const runner = new StandaloneLLMRunnerFactory({
    config: { baseUrl, apiKey, model, timeoutMs, maxTokens: 256 },
  }).createRunner({ enableTools: false });

  for (let run = 1; run <= runs; run++) {
    for (const testCase of cases) {
      let fallback = false;
      let inputChars = 0;
      let outputChars = 0;
      const logger: Logger = {
        info: () => {},
        error: (message) => console.error(message),
        warn: (message) => {
          fallback = true;
          console.warn(`[${testCase.name}] ${message}`);
        },
      };
      const meteredRunner: LLMRunner = {
        run: async (params) => {
          inputChars += params.prompt.length + (params.systemPrompt?.length ?? 0);
          const output = await runner.run(params);
          outputChars += output.length;
          return output;
        },
      };

      const startedAt = performance.now();
      const selected = await selectTaskAwareMemories({
        query: testCase.query,
        candidates: testCase.candidates,
        maxResults: testCase.maxResults,
        timeoutMs,
        runner: meteredRunner,
        logger,
      });

      results.push({
        caseName: testCase.name,
        run,
        baseline: scoreSelection(testCase, testCase.candidates.slice(0, testCase.maxResults)),
        ...scoreSelection(testCase, selected),
        selectedIds: selected.map((candidate) => candidate.memoryId),
        fallback,
        latencyMs: performance.now() - startedAt,
        estimatedInputTokens: Math.ceil(inputChars / 4),
        estimatedOutputTokens: Math.ceil(outputChars / 4),
      });
    }
  }

  const report = buildReport(fixturePath, model, results);
  printReport(report);

  const outputPath = process.env.TDAI_EVAL_OUTPUT;
  if (outputPath) {
    const resolved = path.resolve(outputPath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`Wrote evaluation report to ${resolved}`);
  }
}

function validateCases(value: unknown): EvalCase[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("fixture must be a non-empty array");
  const ids = new Set<string>();
  return value.map((item, caseIndex) => {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.query !== "string") {
      throw new Error(`case ${caseIndex + 1} must contain name and query strings`);
    }
    if (!Number.isInteger(item.maxResults) || (item.maxResults as number) < 1) {
      throw new Error(`case ${item.name} must have a positive integer maxResults`);
    }
    if (!Array.isArray(item.candidates) || item.candidates.length < (item.maxResults as number)) {
      throw new Error(`case ${item.name} has too few candidates`);
    }
    const candidates = item.candidates.map((candidate, candidateIndex): EvalCandidate => {
      if (!isRecord(candidate) || typeof candidate.memoryId !== "string" || typeof candidate.content !== "string") {
        throw new Error(`case ${item.name} candidate ${candidateIndex + 1} is invalid`);
      }
      if (candidate.relevance !== 0 && candidate.relevance !== 1 && candidate.relevance !== 2) {
        throw new Error(`case ${item.name} candidate ${candidateIndex + 1} has invalid relevance`);
      }
      const scopedId = `${item.name}\0${candidate.memoryId}`;
      if (ids.has(scopedId)) throw new Error(`case ${item.name} contains duplicate memoryId ${candidate.memoryId}`);
      ids.add(scopedId);
      return {
        memoryId: candidate.memoryId,
        content: candidate.content,
        relevance: candidate.relevance,
      };
    });
    return { name: item.name, query: item.query, maxResults: item.maxResults as number, candidates };
  });
}

function scoreSelection(testCase: EvalCase, selected: TaskAwareMemoryCandidate[]): Scores {
  const relevanceById = new Map(testCase.candidates.map((candidate) => [candidate.memoryId, candidate.relevance]));
  const selectedRelevance = selected.map((candidate) => relevanceById.get(candidate.memoryId) ?? 0);
  const relevantCount = testCase.candidates.filter((candidate) => candidate.relevance > 0).length;
  const criticalCount = testCase.candidates.filter((candidate) => candidate.relevance === 2).length;
  const usefulSelected = selectedRelevance.filter((relevance) => relevance > 0).length;
  const criticalSelected = selectedRelevance.filter((relevance) => relevance === 2).length;
  const ideal = [...testCase.candidates]
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, testCase.maxResults)
    .map((candidate) => candidate.relevance);
  const idealDcg = dcg(ideal);
  return {
    precisionAtK: usefulSelected / testCase.maxResults,
    recallAtK: relevantCount === 0 ? 1 : usefulSelected / relevantCount,
    ndcgAtK: idealDcg === 0 ? 1 : dcg(selectedRelevance) / idealDcg,
    criticalRecall: criticalCount === 0 ? 1 : criticalSelected / criticalCount,
  };
}

function dcg(relevances: number[]): number {
  return relevances.reduce((sum, relevance, index) => sum + ((2 ** relevance) - 1) / Math.log2(index + 2), 0);
}

function buildReport(fixturePath: string, model: string, results: RunResult[]) {
  const selector = aggregateScores(results);
  const baseline = aggregateScores(results.map((result) => result.baseline));
  const latencies = results.map((result) => result.latencyMs).sort((a, b) => a - b);
  return {
    generatedAt: new Date().toISOString(),
    fixturePath,
    model,
    samples: results.length,
    baseline,
    selector,
    ndcgDelta: selector.ndcgAtK - baseline.ndcgAtK,
    criticalRecallRegressionRate: mean(results.map((result) => Number(result.criticalRecall < result.baseline.criticalRecall))),
    fallbackRate: mean(results.map((result) => Number(result.fallback))),
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    estimatedTokens: {
      input: results.reduce((sum, result) => sum + result.estimatedInputTokens, 0),
      output: results.reduce((sum, result) => sum + result.estimatedOutputTokens, 0),
    },
    results,
  };
}

function aggregateScores(scores: Scores[]): Scores {
  return {
    precisionAtK: mean(scores.map((score) => score.precisionAtK)),
    recallAtK: mean(scores.map((score) => score.recallAtK)),
    ndcgAtK: mean(scores.map((score) => score.ndcgAtK)),
    criticalRecall: mean(scores.map((score) => score.criticalRecall)),
  };
}

function printReport(report: ReturnType<typeof buildReport>): void {
  console.table([
    { variant: "RRF baseline", ...formatScoreRow(report.baseline) },
    { variant: "Task selector", ...formatScoreRow(report.selector) },
  ]);
  console.log(`nDCG@K delta: ${(report.ndcgDelta * 100).toFixed(1)} percentage points`);
  console.log(`Critical-recall regression rate: ${(report.criticalRecallRegressionRate * 100).toFixed(1)}%`);
  console.log(`Fallback rate: ${(report.fallbackRate * 100).toFixed(1)}%`);
  console.log(`Latency: p50=${report.latencyMs.p50.toFixed(0)}ms, p95=${report.latencyMs.p95.toFixed(0)}ms`);
  console.log(`Estimated tokens: input=${report.estimatedTokens.input}, output=${report.estimatedTokens.output}`);
}

function formatScoreRow(score: Scores & { case?: string }) {
  return {
    ...(score.case ? { case: score.case } : {}),
    "Precision@K": score.precisionAtK.toFixed(3),
    "Recall@K": score.recallAtK.toFixed(3),
    "nDCG@K": score.ndcgAtK.toFixed(3),
    "Critical recall": score.criticalRecall.toFixed(3),
  };
}

function percentile(sorted: number[], quantile: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))] ?? 0;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required (use --dry-run to validate fixtures without an API call)`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
