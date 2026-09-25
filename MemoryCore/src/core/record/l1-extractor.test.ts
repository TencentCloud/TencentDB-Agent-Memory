import { describe, expect, it } from "vitest";
import { extractL1Memories, L1ExtractionFailure } from "./l1-extractor.js";
import type { LLMRunner } from "../types.js";

/**
 * Regression tests for #1395 — an L1 extraction FAILURE must not be reported as
 * a successful empty run.
 *
 * Failure modes that used to advance the checkpoint cursor (and therefore made
 * the affected L0 rows unreachable forever):
 *   - the LLM call itself failed (quota / network / timeout)
 *   - the response could not be parsed (e.g. truncated by `max_tokens`)
 *
 * The two "still succeeds" cases are the guard rails for the opposite mistake:
 * a genuine "nothing to remember" must stay a success, otherwise the cursor
 * would never advance and the session would stall forever.
 */

const T = 1_700_000_000_000;

const MESSAGES = [
  {
    id: "m1",
    role: "user" as const,
    content:
      "我的长期项目代号是 Aurora-7，它是一个需要持续维护的系统，后续讨论都以这个项目为背景。",
    timestamp: T,
  },
  {
    id: "m2",
    role: "assistant" as const,
    content: "明白，我会把 Aurora-7 作为长期背景保留，并在后续对话中沿用。",
    timestamp: T + 1,
  },
  {
    id: "m3",
    role: "user" as const,
    content: "Aurora-7 是我未来一年持续维护的核心项目，优先级高于其他临时任务。",
    timestamp: T + 2,
  },
];

function runnerReturning(text: string): LLMRunner {
  return { run: async () => text } as unknown as LLMRunner;
}

function runnerThrowing(message: string): LLMRunner {
  return {
    run: async () => {
      throw new Error(message);
    },
  } as unknown as LLMRunner;
}

function extract(runner: LLMRunner) {
  return extractL1Memories({
    messages: MESSAGES,
    sessionKey: "l1-extractor-test",
    baseDir: "/tmp/l1-extractor-test",
    config: {},
    options: { enableDedup: false, promptMode: "chat", llmRunner: runner },
  });
}

describe("extractL1Memories: failure vs. genuine empty (#1395)", () => {
  it("throws L1ExtractionFailure(llm_error) when the LLM call fails — the batch must be deferred", async () => {
    await expect(extract(runnerThrowing("429 quota exhausted"))).rejects.toBeInstanceOf(
      L1ExtractionFailure,
    );
    await expect(extract(runnerThrowing("429 quota exhausted"))).rejects.toMatchObject({
      reason: "llm_error",
    });
  });

  it("throws (no_json) when the response carries no JSON array — the truncated-output case", async () => {
    // Shape observed in the wild: the model spent its budget on reasoning and
    // the content stopped mid-JSON (finishReason=length).
    const truncated = '[{"scene_name":"用户与AI讨论Aurora-7项目","message_ids":["m1","m2"';
    await expect(extract(runnerReturning(truncated))).rejects.toBeInstanceOf(L1ExtractionFailure);
    await expect(extract(runnerReturning(truncated))).rejects.toMatchObject({ reason: "no_json" });
  });

  it("still succeeds when the model legitimately finds nothing to remember (empty array)", async () => {
    const res = await extract(runnerReturning("[]"));
    expect(res.success).toBe(true);
    expect(res.extractedCount).toBe(0);
    expect(res.storedCount).toBe(0);
  });

  it("still succeeds when scenes are returned with empty memory lists", async () => {
    const res = await extract(
      runnerReturning('[{"scene_name":"用户在设计项目方案","message_ids":["m1"],"memories":[]}]'),
    );
    expect(res.success).toBe(true);
    expect(res.extractedCount).toBe(0);
  });

  it("defers (normalized_all_dropped) when parse succeeded but every memory has an unknown type", async () => {
    // The LLM returned well-formed scenes with real content — only the `type`
    // field is outside the accepted taxonomy. Advancing the cursor here would
    // silently drop the extracted content with no retry.
    const unknownType = JSON.stringify([
      {
        scene_name: "用户在设计项目方案",
        message_ids: ["m1"],
        memories: [
          { type: "mystery_kind", content: "项目方案敲定采用事件溯源架构", priority: 60 },
        ],
      },
    ]);
    await expect(extract(runnerReturning(unknownType))).rejects.toBeInstanceOf(L1ExtractionFailure);
    await expect(extract(runnerReturning(unknownType))).rejects.toMatchObject({
      reason: "normalized_all_dropped",
    });
  });
});
