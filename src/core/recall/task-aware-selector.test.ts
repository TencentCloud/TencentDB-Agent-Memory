import { describe, expect, it, vi } from "vitest";

import type { LLMRunner } from "../types.js";
import {
  getTaskSelectorCandidateLimit,
  selectTaskAwareMemories,
  type TaskAwareMemoryCandidate,
} from "./task-aware-selector.js";

const candidates: TaskAwareMemoryCandidate[] = [
  { memoryId: "old-scene", content: "The previous migration was completed." },
  { memoryId: "blocker", content: "Current blocker: the API contract is undecided." },
  { memoryId: "next-action", content: "Next action: confirm the response schema." },
];

function runnerReturning(output: string): LLMRunner {
  return { run: vi.fn().mockResolvedValue(output) };
}

describe("task-aware memory selector", () => {
  it("returns selected candidates by validated memory ID without rewriting them", async () => {
    const runner = runnerReturning('{"selected_memory_ids":["next-action","blocker"]}');

    const result = await selectTaskAwareMemories({
      query: "What should we do next?",
      candidates,
      maxResults: 2,
      timeoutMs: 3000,
      runner,
    });

    expect(result).toEqual([candidates[2], candidates[1]]);
    const call = vi.mocked(runner.run).mock.calls[0][0];
    expect(call.systemPrompt).toContain("unresolved blockers");
    expect(call.systemPrompt).toContain("next actions");
    expect(JSON.parse(call.prompt)).toMatchObject({
      query: "What should we do next?",
      max_results: 2,
    });
  });

  it("accepts an empty selection when no memory is useful", async () => {
    const result = await selectTaskAwareMemories({
      query: "unrelated question",
      candidates,
      maxResults: 2,
      timeoutMs: 3000,
      runner: runnerReturning('{"selected_memory_ids":[]}'),
    });

    expect(result).toEqual([]);
  });

  it.each([
    ["malformed JSON", "not json"],
    ["unknown IDs", '{"selected_memory_ids":["missing"]}'],
    ["duplicate IDs", '{"selected_memory_ids":["blocker","blocker"]}'],
    ["too many IDs", '{"selected_memory_ids":["old-scene","blocker","next-action"]}'],
  ])("fails open to retrieval ranking for %s", async (_case, output) => {
    const result = await selectTaskAwareMemories({
      query: "continue the task",
      candidates,
      maxResults: 2,
      timeoutMs: 3000,
      runner: runnerReturning(output),
    });

    expect(result).toEqual(candidates.slice(0, 2));
  });

  it("fails open when the LLM runner rejects", async () => {
    const runner: LLMRunner = { run: vi.fn().mockRejectedValue(new Error("timeout")) };

    const result = await selectTaskAwareMemories({
      query: "continue the task",
      candidates,
      maxResults: 2,
      timeoutMs: 3000,
      runner,
    });

    expect(result).toEqual(candidates.slice(0, 2));
  });

  it("fails open when no LLM runner is available", async () => {
    const result = await selectTaskAwareMemories({
      query: "continue the task",
      candidates,
      maxResults: 2,
      timeoutMs: 3000,
    });

    expect(result).toEqual(candidates.slice(0, 2));
  });
});

describe("task selector candidate limit", () => {
  it("uses a bounded multiplier and caps the candidate pool", () => {
    expect(getTaskSelectorCandidateLimit(5, 3)).toBe(15);
    expect(getTaskSelectorCandidateLimit(5, 0)).toBe(5);
    expect(getTaskSelectorCandidateLimit(20, 50)).toBe(100);
    expect(getTaskSelectorCandidateLimit(0, 3)).toBe(0);
  });
});
