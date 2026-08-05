#!/usr/bin/env npx tsx
/**
 * eval-memory — reproducible memory-quality evaluation for the standalone
 * Gateway. See scripts/eval-memory/README.md for usage; issues #106 / #73
 * for motivation.
 *
 *   npm run eval:memory -- --dataset synthetic
 *   npm run eval:memory -- --dataset locomo --max-conversations 2
 */

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { getEncoding } from "js-tiktoken";

import { buildSyntheticDataset, loadLocomoDataset, LOCOMO_DEFAULT_URL } from "./datasets.js";
import { HttpEvalGateway, spawnEvalGateway } from "./gateway.js";
import { createAiSdkEvalLlm } from "./llm.js";
import { detectRepoCommit, summaryLine, writeReport } from "./report.js";
import { aggregateScores, runConversation, sliceDataset, type RunnerOptions } from "./runner.js";
import type { ConversationRunStats, EvalGatewayFactory, QuestionResult, RunReport } from "./types.js";

const HARNESS_VERSION = "0.1.0";
const TAG = "[eval-memory]";

const HELP = `eval-memory — reproducible memory evaluation for the standalone Gateway

USAGE
  npm run eval:memory -- [options]

DATASET
  --dataset <synthetic|locomo>   dataset adapter (default: synthetic)
  --locomo-path <file>           read locomo10.json from disk instead of downloading
  --locomo-url <url>             download URL (default: official snap-research/locomo raw file)
  --include-adversarial          include LoCoMo category-5 questions (excluded by default,
                                 matching mem0ai/memory-benchmarks practice)
  --max-conversations <n>        evaluate only the first n conversations (0 = all)
  --max-questions <n>            evaluate only the first n questions per conversation (0 = all)

GATEWAY
  --gateway-url <url>            reuse an already-running Gateway instead of spawning one.
                                 The caller owns data isolation between conversations.
  --gateway-api-key <key>        API key for --gateway-url mode (or TDAI_GATEWAY_API_KEY)
  --port <n>                     port for spawned Gateways (default: 8437)
  --verbose-gateway              inherit spawned Gateway stdout/stderr

EVALUATION
  --baseline <none|full-context> also answer from the raw transcript for comparison (default: none)
  --baseline-max-chars <n>       transcript truncation for the baseline (default: 60000)
  --settle-timeout-s <n>         max wait for the pipeline to drain per conversation (default: 600)
  --out <dir>                    output directory (default: scripts/eval-memory/results/<timestamp>)
  --dry-run                      parse the dataset and print the plan; no Gateway, no LLM calls

LLM (answerer + judge; extraction uses the Gateway's own config)
  TDAI_LLM_BASE_URL / TDAI_LLM_API_KEY / TDAI_LLM_MODEL     required unless --dry-run
  TDAI_EVAL_ANSWER_MODEL / TDAI_EVAL_JUDGE_MODEL            optional per-role overrides
`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      dataset: { type: "string", default: "synthetic" },
      "locomo-path": { type: "string" },
      "locomo-url": { type: "string" },
      "include-adversarial": { type: "boolean", default: false },
      "max-conversations": { type: "string", default: "0" },
      "max-questions": { type: "string", default: "0" },
      "gateway-url": { type: "string" },
      "gateway-api-key": { type: "string" },
      port: { type: "string", default: "8437" },
      "verbose-gateway": { type: "boolean", default: false },
      baseline: { type: "string", default: "none" },
      "baseline-max-chars": { type: "string", default: "60000" },
      "settle-timeout-s": { type: "string", default: "600" },
      out: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  // ── Dataset ──
  let dataset;
  if (values.dataset === "synthetic") {
    dataset = buildSyntheticDataset();
  } else if (values.dataset === "locomo") {
    dataset = await loadLocomoDataset({
      path: values["locomo-path"],
      url: values["locomo-url"] ?? LOCOMO_DEFAULT_URL,
      includeAdversarial: values["include-adversarial"],
    });
  } else {
    process.stderr.write(`${TAG} unknown dataset "${values.dataset}" (expected synthetic|locomo)\n`);
    return 1;
  }
  dataset = sliceDataset(
    dataset,
    Number(values["max-conversations"]),
    Number(values["max-questions"]),
  );

  const totalSessions = dataset.conversations.reduce((a, c) => a + c.sessions.length, 0);
  const totalQuestions = dataset.conversations.reduce((a, c) => a + c.questions.length, 0);
  process.stdout.write(
    `${TAG} dataset=${dataset.name} conversations=${dataset.conversations.length} ` +
      `sessions=${totalSessions} questions=${totalQuestions}\n`,
  );

  if (values["dry-run"]) {
    for (const c of dataset.conversations) {
      const rounds = c.sessions.reduce((a, s) => a + s.rounds.length, 0);
      process.stdout.write(
        `${TAG}   ${c.conversationId}: ${c.sessions.length} sessions, ${rounds} rounds, ${c.questions.length} questions\n`,
      );
    }
    process.stdout.write(`${TAG} dry run complete — no Gateway or LLM calls were made\n`);
    return 0;
  }

  // ── LLM config ──
  const llmBaseUrl = process.env.TDAI_LLM_BASE_URL ?? "https://api.openai.com/v1";
  const llmApiKey = process.env.TDAI_LLM_API_KEY ?? "";
  const llmModel = process.env.TDAI_LLM_MODEL ?? "gpt-4o";
  if (!llmApiKey) {
    process.stderr.write(`${TAG} TDAI_LLM_API_KEY is required (or use --dry-run)\n`);
    return 1;
  }
  const answerModel = process.env.TDAI_EVAL_ANSWER_MODEL ?? llmModel;
  const judgeModel = process.env.TDAI_EVAL_JUDGE_MODEL ?? llmModel;
  const llm = createAiSdkEvalLlm({
    baseUrl: llmBaseUrl,
    apiKey: llmApiKey,
    answerModel,
    judgeModel,
    timeoutMs: 120_000,
  });

  // ── Gateway factory ──
  const memoryCoreDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const startedAt = new Date();
  const runStamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = values.out
    ? resolve(values.out)
    : join(memoryCoreDir, "scripts", "eval-memory", "results", runStamp);
  mkdirSync(outDir, { recursive: true });

  const externalUrl = values["gateway-url"];
  const gatewayFactory: EvalGatewayFactory = async (conversationId) => {
    if (externalUrl) {
      return new HttpEvalGateway({
        baseUrl: externalUrl,
        apiKey: values["gateway-api-key"] ?? process.env.TDAI_GATEWAY_API_KEY,
      });
    }
    return spawnEvalGateway({
      memoryCoreDir,
      runDir: outDir,
      conversationId,
      port: Number(values.port),
      llm: { baseUrl: llmBaseUrl, apiKey: llmApiKey, model: llmModel },
      verbose: values["verbose-gateway"],
    });
  };
  if (externalUrl && dataset.conversations.length > 1) {
    process.stdout.write(
      `${TAG} WARNING: --gateway-url with ${dataset.conversations.length} conversations shares one ` +
        `memory store across all of them; recall may cross-contaminate. Prefer spawned mode for scoring.\n`,
    );
  }

  // ── Run ──
  const encoding = getEncoding("cl100k_base");
  const runnerOpts: RunnerOptions = {
    baseline: values.baseline === "full-context" ? "full-context" : "none",
    baselineMaxChars: Number(values["baseline-max-chars"]),
    settleTimeoutMs: Number(values["settle-timeout-s"]) * 1000,
    settleStablePolls: 5,
    settlePollIntervalMs: 1000,
    settleFallbackMs: 30_000,
    countTokens: (text) => (text ? encoding.encode(text).length : 0),
    log: (line) => process.stdout.write(`${TAG} ${line}\n`),
  };

  const allResults: QuestionResult[] = [];
  const allStats: ConversationRunStats[] = [];
  for (const convo of dataset.conversations) {
    const outcome = await runConversation(convo, gatewayFactory, llm, runnerOpts);
    allResults.push(...outcome.results);
    allStats.push(outcome.stats);
  }

  // ── Report ──
  const scores = aggregateScores(allResults);
  const report: RunReport = {
    metadata: {
      harnessVersion: HARNESS_VERSION,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      repoCommit: detectRepoCommit(memoryCoreDir),
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
      dataset: {
        name: dataset.name,
        source: dataset.source,
        conversations: dataset.conversations.length,
        sessions: totalSessions,
        questions: totalQuestions,
      },
      models: { extraction: llmModel, answer: answerModel, judge: judgeModel },
      gateway: {
        mode: externalUrl ? "external" : "spawned",
        url: externalUrl ?? `http://127.0.0.1:${values.port}`,
      },
      flags: {
        dataset: values.dataset,
        baseline: runnerOpts.baseline,
        includeAdversarial: values["include-adversarial"],
        maxConversations: Number(values["max-conversations"]),
        maxQuestions: Number(values["max-questions"]),
      },
    },
    scores,
    conversations: allStats,
    results: allResults,
  };
  const { jsonPath, mdPath } = writeReport(outDir, report);

  process.stdout.write(`${TAG} ${summaryLine(scores)}\n`);
  process.stdout.write(`${TAG} report: ${mdPath}\n`);
  process.stdout.write(`${TAG} detail: ${jsonPath}\n`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`${TAG} ${message}\n`);
  process.exitCode = 1;
}
