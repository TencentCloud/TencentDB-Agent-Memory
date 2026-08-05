/**
 * eval-memory — answerer + judge LLM.
 *
 * Uses the same `ai` + `@ai-sdk/openai` stack the standalone Gateway's own
 * LLM runner is built on (src/adapters/standalone/llm-runner.ts), so the
 * harness adds no new dependency and honours the same TDAI_LLM_* env vars.
 *
 * Prompt structure (answer from retrieved context only; lenient binary
 * LLM-as-judge against the gold answer) follows mem0ai/memory-benchmarks
 * (Apache-2.0): https://github.com/mem0ai/memory-benchmarks
 */

import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

import type { EvalLlm, JudgeVerdict } from "./types.js";

export interface LlmEndpointConfig {
  baseUrl: string;
  apiKey: string;
  answerModel: string;
  judgeModel: string;
  timeoutMs: number;
}

const ANSWER_SYSTEM = `You are answering questions about a past conversation.
Use ONLY the information in the provided context. Be concise: answer in one
short sentence or phrase, without preamble. If the context does not contain
the information needed, reply exactly: "The information is not mentioned in
the conversation".`;

const JUDGE_SYSTEM = `You are grading whether a generated answer matches a
gold answer for a question about a conversation. Reply with a single JSON
object: {"correct": true|false, "reason": "<one sentence>"}.
Grade leniently on wording: paraphrases, extra correct detail, or different
date formats for the same date are all CORRECT. Grade strictly on facts:
wrong entity, wrong value, wrong date, or a made-up answer is WRONG. An
answer that says the information is unavailable is only CORRECT when the
gold answer also says so.`;

export function createAiSdkEvalLlm(cfg: LlmEndpointConfig): EvalLlm {
  const provider = createOpenAI({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey });

  async function complete(model: string, system: string, prompt: string): Promise<string> {
    const result = await generateText({
      model: provider.chat(model),
      system,
      prompt,
      abortSignal: AbortSignal.timeout(cfg.timeoutMs),
    });
    return result.text.trim();
  }

  return {
    async answer(question, context, mode) {
      const label = mode === "memory" ? "Retrieved memory context" : "Conversation transcript";
      return complete(
        cfg.answerModel,
        ANSWER_SYSTEM,
        `${label}:\n"""\n${context || "(empty)"}\n"""\n\nQuestion: ${question}\nAnswer:`,
      );
    },

    async judge(question, goldAnswer, generated): Promise<JudgeVerdict> {
      const text = await complete(
        cfg.judgeModel,
        JUDGE_SYSTEM,
        `Question: ${question}\nGold answer: ${goldAnswer}\nGenerated answer: ${generated}\n\nJSON verdict:`,
      );
      return parseJudgeVerdict(text);
    },
  };
}

/**
 * Judges occasionally wrap the JSON in prose or code fences; extract the
 * first JSON object rather than failing the whole question. An unparseable
 * verdict counts as WRONG so a flaky judge can only under-report accuracy,
 * never inflate it.
 */
export function parseJudgeVerdict(text: string): JudgeVerdict {
  const match = /\{[\s\S]*?\}/.exec(text);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { correct?: unknown; reason?: unknown };
      if (typeof parsed.correct === "boolean") {
        return { correct: parsed.correct, reason: String(parsed.reason ?? "") };
      }
    } catch {
      // fall through
    }
  }
  return { correct: false, reason: `unparseable judge output: ${text.slice(0, 200)}` };
}
