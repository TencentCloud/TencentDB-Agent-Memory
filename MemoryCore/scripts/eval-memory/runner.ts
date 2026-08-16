/**
 * eval-memory — orchestration.
 *
 * Pure logic over the EvalGateway / EvalLlm seams so the whole flow is
 * unit-testable without a Gateway process or network:
 *
 *   per conversation:  ingest (capture rounds) → flush (/session/end)
 *                      → settle (pipeline drains) → answer (recall-only
 *                      context) → judge
 *   then:              aggregate per-category scores
 */

import { conversationTranscript } from "./datasets.js";
import { sleep } from "./gateway.js";
import type {
  AnswerOutcome,
  CategoryScore,
  ConversationRunStats,
  EvalConversation,
  EvalDataset,
  EvalGateway,
  EvalGatewayFactory,
  EvalLlm,
  PipelineStatus,
  QuestionCategory,
  QuestionResult,
} from "./types.js";

export interface RunnerOptions {
  /** "none" (default) or "full-context" — adds a no-memory comparison run. */
  baseline: "none" | "full-context";
  baselineMaxChars: number;
  /** Hard cap on waiting for the pipeline to drain, per conversation. */
  settleTimeoutMs: number;
  /** Pipeline must report all layers idle this many consecutive polls. */
  settleStablePolls: number;
  settlePollIntervalMs: number;
  /** Fallback wait when /v2/pipeline/status is unavailable. */
  settleFallbackMs: number;
  /** Rough token count for context-size reporting. */
  countTokens: (text: string) => number;
  log: (line: string) => void;
}

export interface ConversationOutcome {
  stats: ConversationRunStats;
  results: QuestionResult[];
}

export async function runConversation(
  convo: EvalConversation,
  gatewayFactory: EvalGatewayFactory,
  llm: EvalLlm,
  opts: RunnerOptions,
): Promise<ConversationOutcome> {
  const gateway = await gatewayFactory(convo.conversationId);
  try {
    // ── Ingest ──
    const ingestStart = Date.now();
    let rounds = 0;
    for (const session of convo.sessions) {
      for (const round of session.rounds) {
        await gateway.capture(session.sessionKey, round.user, round.assistant);
        rounds++;
      }
      // Flush per session so buffered L1 work is extracted even when the
      // round count never crosses the everyN threshold.
      await gateway.sessionEnd(session.sessionKey);
    }
    const ingestMs = Date.now() - ingestStart;

    // ── Settle ──
    const settleStart = Date.now();
    const settled = await waitForPipeline(gateway, opts);
    const settleMs = Date.now() - settleStart;
    const l1Records = await gateway.countL1();
    opts.log(
      `[${convo.conversationId}] ingested ${rounds} rounds in ${ingestMs}ms; ` +
        `settled=${settled} in ${settleMs}ms; l1_records=${l1Records ?? "n/a"}`,
    );

    // ── Answer + judge ──
    const recallSessionKey = `${convo.conversationId}:eval`;
    const results: QuestionResult[] = [];
    for (const q of convo.questions) {
      const memory = await answerFromMemory(gateway, llm, q.question, q.goldAnswer, recallSessionKey, opts);
      let baseline: AnswerOutcome | undefined;
      if (opts.baseline === "full-context") {
        baseline = await answerFromTranscript(llm, convo, q.question, q.goldAnswer, opts);
      }
      results.push({
        conversationId: convo.conversationId,
        questionId: q.id,
        category: q.category,
        question: q.question,
        goldAnswer: q.goldAnswer,
        memory,
        baseline,
      });
      opts.log(
        `[${convo.conversationId}] ${q.id} (${q.category}) memory=${memory.correct ? "✓" : "✗"}` +
          (baseline ? ` baseline=${baseline.correct ? "✓" : "✗"}` : ""),
      );
    }

    return {
      stats: {
        conversationId: convo.conversationId,
        sessions: convo.sessions.length,
        rounds,
        l1Records,
        ingestMs,
        settleMs,
        settled,
      },
      results,
    };
  } finally {
    await gateway.close();
  }
}

async function answerFromMemory(
  gateway: EvalGateway,
  llm: EvalLlm,
  question: string,
  goldAnswer: string,
  sessionKey: string,
  opts: RunnerOptions,
): Promise<AnswerOutcome> {
  const start = Date.now();
  const recall = await gateway.recall(question, sessionKey);
  const answer = await llm.answer(question, recall.context, "memory");
  const verdict = await llm.judge(question, goldAnswer, answer);
  return {
    answer,
    correct: verdict.correct,
    judgeReason: verdict.reason,
    contextChars: recall.context.length,
    contextTokens: opts.countTokens(recall.context),
    recallStrategy: recall.strategy,
    recallMemoryCount: recall.memoryCount,
    recallCode: recall.code,
    latencyMs: Date.now() - start,
  };
}

async function answerFromTranscript(
  llm: EvalLlm,
  convo: EvalConversation,
  question: string,
  goldAnswer: string,
  opts: RunnerOptions,
): Promise<AnswerOutcome> {
  const start = Date.now();
  const transcript = conversationTranscript(convo, opts.baselineMaxChars);
  const answer = await llm.answer(question, transcript, "baseline");
  const verdict = await llm.judge(question, goldAnswer, answer);
  return {
    answer,
    correct: verdict.correct,
    judgeReason: verdict.reason,
    contextChars: transcript.length,
    contextTokens: opts.countTokens(transcript),
    latencyMs: Date.now() - start,
  };
}

/**
 * Wait until L1/L2/L3 all report idle for `settleStablePolls` consecutive
 * polls. The stability window matters because the L2/L3 cascade is armed
 * by short timers — a single idle snapshot between L1 finishing and the
 * L2 timer firing would otherwise end the wait early. Queue-based status
 * (not conversation-count heuristics) deliberately avoids the failure
 * mode reported for /seed's waitL1 in issue #505.
 */
export async function waitForPipeline(
  gateway: { pipelineStatus: () => Promise<PipelineStatus | null> },
  opts: Pick<RunnerOptions, "settleTimeoutMs" | "settleStablePolls" | "settlePollIntervalMs" | "settleFallbackMs" | "log">,
): Promise<boolean> {
  const first = await gateway.pipelineStatus();
  if (first === null) {
    opts.log(`pipeline status unavailable — falling back to a fixed ${opts.settleFallbackMs}ms wait`);
    await sleep(opts.settleFallbackMs);
    return false;
  }

  const deadline = Date.now() + opts.settleTimeoutMs;
  let stable = 0;
  while (Date.now() < deadline) {
    const status = await gateway.pipelineStatus();
    const idle = status !== null && status.l1.idle && status.l2.idle && status.l3.idle;
    stable = idle ? stable + 1 : 0;
    if (stable >= opts.settleStablePolls) return true;
    await sleep(opts.settlePollIntervalMs);
  }
  opts.log(`pipeline did not fully drain within ${opts.settleTimeoutMs}ms — continuing anyway`);
  return false;
}

// ============================
// Aggregation
// ============================

const CATEGORY_ORDER: Array<QuestionCategory | "overall"> = [
  "overall",
  "single-hop",
  "multi-hop",
  "temporal",
  "open-domain",
  "adversarial",
];

export function aggregateScores(results: QuestionResult[]): CategoryScore[] {
  const hasBaseline = results.some((r) => r.baseline !== undefined);

  function scoreFor(category: QuestionCategory | "overall"): CategoryScore | null {
    const subset = category === "overall" ? results : results.filter((r) => r.category === category);
    if (subset.length === 0) return null;
    const memoryCorrect = subset.filter((r) => r.memory.correct).length;
    const score: CategoryScore = {
      category,
      total: subset.length,
      memoryCorrect,
      memoryAccuracy: round4(memoryCorrect / subset.length),
      avgMemoryContextTokens: Math.round(avg(subset.map((r) => r.memory.contextTokens))),
    };
    if (hasBaseline) {
      const withBaseline = subset.filter((r) => r.baseline !== undefined);
      if (withBaseline.length > 0) {
        const baselineCorrect = withBaseline.filter((r) => r.baseline?.correct).length;
        score.baselineCorrect = baselineCorrect;
        score.baselineAccuracy = round4(baselineCorrect / withBaseline.length);
        score.avgBaselineContextTokens = Math.round(
          avg(withBaseline.map((r) => r.baseline?.contextTokens ?? 0)),
        );
      }
    }
    return score;
  }

  return CATEGORY_ORDER.map(scoreFor).filter((s): s is CategoryScore => s !== null);
}

function avg(nums: number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ============================
// Dataset slicing (cheap runs)
// ============================

export function sliceDataset(
  dataset: EvalDataset,
  maxConversations: number,
  maxQuestionsPerConversation: number,
): EvalDataset {
  const conversations = dataset.conversations
    .slice(0, maxConversations > 0 ? maxConversations : dataset.conversations.length)
    .map((c) => ({
      ...c,
      questions: c.questions.slice(
        0,
        maxQuestionsPerConversation > 0 ? maxQuestionsPerConversation : c.questions.length,
      ),
    }));
  return { ...dataset, conversations };
}
