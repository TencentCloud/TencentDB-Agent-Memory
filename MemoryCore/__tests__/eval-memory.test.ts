/**
 * Unit tests for scripts/eval-memory — pure logic only (dataset adapters,
 * orchestration over DI fakes, judge parsing, aggregation, report render).
 * No Gateway process, no network, no LLM.
 */

import { describe, expect, it } from "vitest";

import {
  buildSyntheticDataset,
  conversationTranscript,
  pairLocomoTurns,
  parseLocomoSample,
} from "../scripts/eval-memory/datasets.js";
import { parseJudgeVerdict } from "../scripts/eval-memory/llm.js";
import { renderMarkdown, summaryLine } from "../scripts/eval-memory/report.js";
import {
  aggregateScores,
  runConversation,
  sliceDataset,
  waitForPipeline,
  type RunnerOptions,
} from "../scripts/eval-memory/runner.js";
import type {
  EvalGateway,
  EvalLlm,
  PipelineStatus,
  QuestionResult,
  RunReport,
} from "../scripts/eval-memory/types.js";

// ============================
// Fakes (DI, no module mocks)
// ============================

function idleStatus(): PipelineStatus {
  const layer = { queued: 0, running: 0, idle: true };
  return { l1: { ...layer }, l2: { ...layer }, l3: { ...layer } };
}

class FakeGateway implements EvalGateway {
  captures: Array<{ sessionKey: string; user: string; assistant: string }> = [];
  sessionEnds: string[] = [];
  recallQueries: string[] = [];
  closed = false;
  statusSequence: Array<PipelineStatus | null>;
  recallContext: string;

  constructor(opts?: { statusSequence?: Array<PipelineStatus | null>; recallContext?: string }) {
    this.statusSequence = opts?.statusSequence ?? [];
    this.recallContext = opts?.recallContext ?? "Dana adopted a corgi named Biscuit.";
  }

  async capture(sessionKey: string, user: string, assistant: string): Promise<void> {
    this.captures.push({ sessionKey, user, assistant });
  }
  async sessionEnd(sessionKey: string): Promise<void> {
    this.sessionEnds.push(sessionKey);
  }
  async pipelineStatus(): Promise<PipelineStatus | null> {
    return this.statusSequence.length > 0 ? this.statusSequence.shift()! : idleStatus();
  }
  async recall(query: string): Promise<import("../scripts/eval-memory/types.js").RecallResult> {
    this.recallQueries.push(query);
    return { context: this.recallContext, strategy: "fts", memoryCount: 1, code: 0 };
  }
  async countL1(): Promise<number | null> {
    return 3;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

/** Answers with the recalled context verbatim; judges by substring. */
const fakeLlm: EvalLlm = {
  async answer(_question, context) {
    return context || "The information is not mentioned in the conversation";
  },
  async judge(_question, goldAnswer, generated) {
    const correct = generated.toLowerCase().includes(goldAnswer.toLowerCase());
    return { correct, reason: correct ? "match" : "mismatch" };
  },
};

function testRunnerOpts(overrides?: Partial<RunnerOptions>): RunnerOptions {
  return {
    baseline: "none",
    baselineMaxChars: 60_000,
    settleTimeoutMs: 2_000,
    settleStablePolls: 2,
    settlePollIntervalMs: 1,
    settleFallbackMs: 5,
    countTokens: (text) => Math.ceil(text.length / 4),
    log: () => {},
    ...overrides,
  };
}

// ============================
// LoCoMo adapter
// ============================

describe("pairLocomoTurns", () => {
  it("maps speaker_a to user, merges consecutive same-speaker lines, keeps names", () => {
    const rounds = pairLocomoTurns(
      [
        { speaker: "Melanie", text: "Hi Caroline!" },
        { speaker: "Melanie", text: "How was your week?" },
        { speaker: "Caroline", text: "Great, I went hiking." },
        { speaker: "Melanie", text: "Nice!" },
        { speaker: "Caroline", text: "You should join next time." },
      ],
      "Melanie",
      undefined,
    );
    expect(rounds).toHaveLength(2);
    expect(rounds[0].user).toBe("Melanie: Hi Caroline!\nMelanie: How was your week?");
    expect(rounds[0].assistant).toBe("Caroline: Great, I went hiking.");
    expect(rounds[1].user).toBe("Melanie: Nice!");
    expect(rounds[1].assistant).toBe("Caroline: You should join next time.");
  });

  it("anchors the session date on the first round and fills structural gaps", () => {
    const rounds = pairLocomoTurns(
      [{ speaker: "Caroline", text: "Guess what happened!" }],
      "Melanie",
      "1:56 pm on 8 May, 2023",
    );
    expect(rounds).toHaveLength(1);
    expect(rounds[0].user).toContain("1:56 pm on 8 May, 2023");
    expect(rounds[0].user).toContain("(listens)");
    expect(rounds[0].assistant).toBe("Caroline: Guess what happened!");
  });

  it("includes image captions so visual turns are not silently dropped", () => {
    const rounds = pairLocomoTurns(
      [
        { speaker: "Melanie", text: "Look at this!", blip_caption: "a dog on a beach" },
        { speaker: "Caroline", text: "Cute!" },
      ],
      "Melanie",
      undefined,
    );
    expect(rounds[0].user).toContain("[shares an image: a dog on a beach]");
  });
});

describe("parseLocomoSample", () => {
  const sample = {
    sample_id: "conv-26",
    conversation: {
      speaker_a: "Melanie",
      speaker_b: "Caroline",
      session_2_date_time: "2:14 pm on 20 June, 2023",
      session_2: [
        { speaker: "Melanie", text: "I started pottery classes." },
        { speaker: "Caroline", text: "That sounds relaxing." },
      ],
      session_1_date_time: "1:56 pm on 8 May, 2023",
      session_1: [
        { speaker: "Melanie", text: "Hi!" },
        { speaker: "Caroline", text: "Hello!" },
      ],
    },
    qa: [
      { question: "What hobby did Melanie start?", answer: "Pottery", category: 4, evidence: ["D2:1"] },
      { question: "How long between sessions?", answer: "About six weeks", category: 2 },
      { question: "What is Melanie's cat called?", adversarial_answer: "Whiskers", category: 5 },
    ],
  };

  it("orders sessions numerically and maps categories to names", () => {
    const convo = parseLocomoSample(sample, 0, false);
    expect(convo.conversationId).toBe("conv-26");
    expect(convo.sessions.map((s) => s.sessionKey)).toEqual([
      "conv-26:session_1",
      "conv-26:session_2",
    ]);
    expect(convo.sessions[0].dateTime).toBe("1:56 pm on 8 May, 2023");
    expect(convo.questions.map((q) => q.category)).toEqual(["single-hop", "temporal"]);
  });

  it("keeps adversarial questions only when asked, with an abstention gold answer", () => {
    const convo = parseLocomoSample(sample, 0, true);
    expect(convo.questions).toHaveLength(3);
    const adversarial = convo.questions.find((q) => q.category === "adversarial");
    expect(adversarial?.goldAnswer).toMatch(/not mentioned/i);
  });
});

// ============================
// Runner
// ============================

describe("runConversation", () => {
  it("captures every round, flushes each session, and judges answers", async () => {
    const dataset = buildSyntheticDataset();
    const convo = dataset.conversations[0];
    const gateway = new FakeGateway({ recallContext: "Biscuit" });
    const outcome = await runConversation(convo, async () => gateway, fakeLlm, testRunnerOpts());

    const expectedRounds = convo.sessions.reduce((a, s) => a + s.rounds.length, 0);
    expect(gateway.captures).toHaveLength(expectedRounds);
    expect(gateway.sessionEnds).toEqual(convo.sessions.map((s) => s.sessionKey));
    expect(gateway.closed).toBe(true);
    expect(outcome.stats.rounds).toBe(expectedRounds);
    expect(outcome.stats.l1Records).toBe(3);
    expect(outcome.results).toHaveLength(convo.questions.length);

    // The fake recall context only contains "Biscuit", so exactly the
    // questions whose gold answer is "Biscuit" should be judged correct.
    const byId = new Map(outcome.results.map((r) => [r.questionId, r]));
    expect(byId.get("syn-q4")?.memory.correct).toBe(true);
    expect(byId.get("syn-q1")?.memory.correct).toBe(false);
  });

  it("adds a baseline outcome when requested", async () => {
    const dataset = buildSyntheticDataset();
    const convo = dataset.conversations[0];
    const gateway = new FakeGateway({ recallContext: "" });
    const outcome = await runConversation(
      convo,
      async () => gateway,
      fakeLlm,
      testRunnerOpts({ baseline: "full-context" }),
    );
    // Baseline answers from the raw transcript, which contains Biscuit.
    const q4 = outcome.results.find((r) => r.questionId === "syn-q4");
    expect(q4?.baseline?.correct).toBe(true);
    expect(q4?.memory.correct).toBe(false);
    expect(q4?.baseline?.contextTokens).toBeGreaterThan(0);
  });

  it("closes the gateway even when a question throws", async () => {
    const gateway = new FakeGateway();
    gateway.recall = async () => {
      throw new Error("boom");
    };
    const dataset = buildSyntheticDataset();
    await expect(
      runConversation(dataset.conversations[0], async () => gateway, fakeLlm, testRunnerOpts()),
    ).rejects.toThrow("boom");
    expect(gateway.closed).toBe(true);
  });
});

describe("waitForPipeline", () => {
  it("requires consecutive idle polls before declaring the pipeline drained", async () => {
    const busy: PipelineStatus = {
      ...idleStatus(),
      l1: { queued: 1, running: 0, idle: false },
    };
    // idle → busy (L2 timer fired) → idle → idle: must not settle on poll 1.
    const gateway = new FakeGateway({
      statusSequence: [idleStatus(), idleStatus(), busy, idleStatus(), idleStatus()],
    });
    const settled = await waitForPipeline(gateway, testRunnerOpts());
    expect(settled).toBe(true);
    // The busy snapshot reset the stability counter, so 5 polls were needed.
    expect(gateway.statusSequence).toHaveLength(0);
  });

  it("falls back to a fixed wait when the status endpoint is unavailable", async () => {
    const gateway = new FakeGateway({ statusSequence: [null] });
    const settled = await waitForPipeline(gateway, testRunnerOpts());
    expect(settled).toBe(false);
  });

  it("gives up after the timeout when the pipeline never drains", async () => {
    const busy: PipelineStatus = {
      ...idleStatus(),
      l1: { queued: 1, running: 1, idle: false },
    };
    const gateway = new FakeGateway({ statusSequence: [] });
    gateway.pipelineStatus = async () => busy;
    const settled = await waitForPipeline(gateway, testRunnerOpts({ settleTimeoutMs: 30 }));
    expect(settled).toBe(false);
  });
});

// ============================
// Judge parsing & aggregation
// ============================

describe("parseJudgeVerdict", () => {
  it("parses a clean verdict", () => {
    expect(parseJudgeVerdict('{"correct": true, "reason": "matches"}')).toEqual({
      correct: true,
      reason: "matches",
    });
  });

  it("extracts JSON wrapped in prose or fences", () => {
    const verdict = parseJudgeVerdict('Sure!\n```json\n{"correct": false, "reason": "wrong date"}\n```');
    expect(verdict.correct).toBe(false);
    expect(verdict.reason).toBe("wrong date");
  });

  it("counts unparseable judge output as wrong, never correct", () => {
    const verdict = parseJudgeVerdict("The answer seems fine to me");
    expect(verdict.correct).toBe(false);
    expect(verdict.reason).toContain("unparseable");
  });
});

describe("aggregateScores", () => {
  function result(
    category: QuestionResult["category"],
    memoryCorrect: boolean,
    baselineCorrect?: boolean,
  ): QuestionResult {
    return {
      conversationId: "c1",
      questionId: `${category}-${Math.random()}`,
      category,
      question: "q",
      goldAnswer: "a",
      memory: {
        answer: "a",
        correct: memoryCorrect,
        judgeReason: "",
        contextChars: 100,
        contextTokens: 25,
        latencyMs: 1,
      },
      baseline:
        baselineCorrect === undefined
          ? undefined
          : {
              answer: "a",
              correct: baselineCorrect,
              judgeReason: "",
              contextChars: 4000,
              contextTokens: 1000,
              latencyMs: 1,
            },
    };
  }

  it("computes overall and per-category accuracy", () => {
    const scores = aggregateScores([
      result("single-hop", true),
      result("single-hop", false),
      result("temporal", true),
    ]);
    const overall = scores.find((s) => s.category === "overall");
    expect(overall).toMatchObject({ total: 3, memoryCorrect: 2 });
    expect(overall?.memoryAccuracy).toBeCloseTo(2 / 3, 3);
    const singleHop = scores.find((s) => s.category === "single-hop");
    expect(singleHop).toMatchObject({ total: 2, memoryCorrect: 1, memoryAccuracy: 0.5 });
    // Categories with no questions are omitted rather than reported as 0/0.
    expect(scores.find((s) => s.category === "adversarial")).toBeUndefined();
  });

  it("tracks baseline accuracy and context tokens separately", () => {
    const scores = aggregateScores([
      result("temporal", false, true),
      result("temporal", true, true),
    ]);
    const overall = scores.find((s) => s.category === "overall");
    expect(overall?.baselineAccuracy).toBe(1);
    expect(overall?.memoryAccuracy).toBe(0.5);
    expect(overall?.avgBaselineContextTokens).toBe(1000);
    expect(overall?.avgMemoryContextTokens).toBe(25);
  });
});

// ============================
// Dataset utilities & report
// ============================

describe("sliceDataset / conversationTranscript", () => {
  it("limits conversations and questions when caps are positive", () => {
    const dataset = buildSyntheticDataset();
    const sliced = sliceDataset(dataset, 1, 2);
    expect(sliced.conversations).toHaveLength(1);
    expect(sliced.conversations[0].questions).toHaveLength(2);
    // 0 = unlimited
    const unsliced = sliceDataset(dataset, 0, 0);
    expect(unsliced.conversations[0].questions).toHaveLength(
      dataset.conversations[0].questions.length,
    );
  });

  it("keeps the transcript tail when truncating (later facts win)", () => {
    const convo = buildSyntheticDataset().conversations[0];
    const truncated = conversationTranscript(convo, 200);
    expect(truncated.length).toBeLessThanOrEqual(200);
    expect(truncated).toContain("Biscuit");
  });
});

describe("report rendering", () => {
  it("renders metadata, accuracy rows, and methodology credits", () => {
    const results: QuestionResult[] = [
      {
        conversationId: "c1",
        questionId: "q1",
        category: "single-hop",
        question: "What is the pet's name?",
        goldAnswer: "Biscuit",
        memory: {
          answer: "Rex",
          correct: false,
          judgeReason: "wrong pet",
          contextChars: 10,
          contextTokens: 3,
          latencyMs: 5,
        },
      },
    ];
    const report: RunReport = {
      metadata: {
        harnessVersion: "0.1.0",
        startedAt: "2026-08-05T00:00:00Z",
        finishedAt: "2026-08-05T00:10:00Z",
        repoCommit: "abc1234",
        nodeVersion: "v22.16.0",
        platform: "linux-x64",
        dataset: { name: "synthetic-smoke", source: "built-in", conversations: 1, sessions: 2, questions: 1 },
        models: { extraction: "gpt-4o", answer: "gpt-4o", judge: "gpt-4o" },
        gateway: { mode: "spawned", url: "http://127.0.0.1:8437" },
        flags: { dataset: "synthetic" },
      },
      scores: aggregateScores(results),
      conversations: [
        {
          conversationId: "c1",
          sessions: 2,
          rounds: 5,
          l1Records: 4,
          ingestMs: 100,
          settleMs: 2000,
          settled: true,
        },
      ],
      results,
    };
    const md = renderMarkdown(report);
    expect(md).toContain("synthetic-smoke");
    expect(md).toContain("abc1234");
    expect(md).toContain("| overall | 1 | 0.0% (0/1) |");
    expect(md).toContain("mem0ai/memory-benchmarks");
    expect(md).toContain("wrong pet");
    expect(summaryLine(report.scores)).toContain("0.0%");
  });
});
