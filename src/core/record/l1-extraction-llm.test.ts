/**
 * Unit tests for the L1 retry path: a malformed (unparseable) LLM response
 * triggers exactly one retry; when both calls fail, extraction reports
 * success:false so the runner preserves the cursor (no silent data loss).
 */
import { describe, expect, it, vi } from "vitest";
import { extractL1Memories } from "./l1-extractor.js";
import type { LLMRunner } from "../types.js";

function makeRunner(responses: string[]): LLMRunner & { calls: number } {
  let idx = 0;
  return {
    calls: 0,
    async run() {
      this.calls += 1;
      const r = responses[Math.min(idx, responses.length - 1)];
      idx += 1;
      return r;
    },
  };
}

const VALID_JSON = JSON.stringify([
  {
    scene_name: "test scene",
    message_ids: ["m1"],
    memories: [
      { content: "The user prefers dark theme for editors", type: "persona", scope: "project", priority: 50 },
    ],
  },
]);

const MALFORMED = "Here is the JSON I found: [unterminated";

function makeMessages() {
  return [
    { id: "m1", role: "user" as const, content: "I prefer dark theme in all my editors", timestamp: Date.now() },
  ];
}

describe("extractL1Memories retry on parse failure", () => {
  it("retries once when the first LLM response is unparseable and succeeds on the retry", async () => {
    const runner = makeRunner([MALFORMED, VALID_JSON]);

    const result = await extractL1Memories({
      messages: makeMessages(),
      sessionKey: "test-session",
      projectId: "proj1",
      baseDir: "/tmp/l1-retry-test-1",
      config: {},
      options: { enableDedup: false, llmRunner: runner },
    });

    expect(runner.calls).toBe(2); // exactly one retry
    expect(result.success).toBe(true);
    expect(result.extractedCount).toBe(1);
  });

  it("reports success:false when both attempts return unparseable responses", async () => {
    const runner = makeRunner([MALFORMED, MALFORMED]);

    const result = await extractL1Memories({
      messages: makeMessages(),
      sessionKey: "test-session",
      projectId: "proj1",
      baseDir: "/tmp/l1-retry-test-2",
      config: {},
      options: { enableDedup: false, llmRunner: runner },
    });

    expect(runner.calls).toBe(2); // attempted retry
    expect(result.success).toBe(false);
    expect(result.error).toContain("parse failed after retry");
    expect(result.extractedCount).toBe(0);
  });
});
