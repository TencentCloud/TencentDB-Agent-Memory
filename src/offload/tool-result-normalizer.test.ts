import { describe, expect, it } from "vitest";
import { normalizeToolResultForPrompt, stableSerialize } from "./tool-result-normalizer.js";
import { applyFrontOffloadResult } from "./hooks/after-tool-call.js";

describe("normalizeToolResultForPrompt", () => {
  it("keeps small tool results inline", async () => {
    const result = await normalizeToolResultForPrompt({
      toolName: "small",
      toolCallId: "tc-small",
      timestamp: "2026-07-06T00:00:00.000Z",
      result: { ok: true },
      maxTokens: 100,
      writeRef: async () => "refs/unused.md",
    });

    expect(result.offloaded).toBe(false);
    expect(result.promptResult).toEqual({ ok: true });
  });

  it("offloads large tool results with deterministic serialization and content hash", async () => {
    const refs: string[] = [];
    const result = await normalizeToolResultForPrompt({
      toolName: "read_file",
      toolCallId: "tc-large",
      timestamp: "2026-07-06T00:00:00.000Z",
      result: { b: "x".repeat(1000), a: 1 },
      maxTokens: 20,
      summaryMaxTokens: 20,
      previewMaxChars: 60,
      writeRef: async (content) => {
        refs.push(content);
        return "refs/tc-large.md";
      },
    });

    expect(result.offloaded).toBe(true);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toBe(stableSerialize({ a: 1, b: "x".repeat(1000) }));
    expect(result.promptResult).toMatchObject({
      _tdai_offloaded: true,
      result_ref: "refs/tc-large.md",
      tool_call_id: "tc-large",
    });
    expect(JSON.stringify(result.promptResult)).toContain(result.contentHash);
  });
});

describe("applyFrontOffloadResult", () => {
  it("keeps the raw event result when prompt-facing history has no matching tool result", () => {
    const rawResult = "X".repeat(4_000);
    const event = {
      result: rawResult,
      messages: [{ role: "toolResult", toolCallId: "different-call", content: rawResult }],
    };
    const promptResult = { _tdai_offloaded: true, result_ref: "refs/tool-result.md" };

    expect(applyFrontOffloadResult(event, "call-1", promptResult)).toBe(false);
    expect(event.result).toBe(rawResult);
    expect(event.messages[0].content).toBe(rawResult);
  });
});
