/**
 * recall-injection.test.ts — Unit tests for stripRecallFromUserMessage and hasRecallInjection.
 */
import { describe, expect, it } from "vitest";
import { stripRecallFromUserMessage, hasRecallInjection } from "./recall-injection.js";

const TENCENTDB_PREAMBLE = "以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：";

function makeRecallBlock(memories: string): string {
  return `<relevant-memories>\n${TENCENTDB_PREAMBLE}\n\n${memories}\n</relevant-memories>`;
}

// ======================================================
// stripRecallFromUserMessage — string content
// ======================================================

describe("stripRecallFromUserMessage — string content", () => {
  it("strips TencentDB-generated recall block", () => {
    const input = `${makeRecallBlock("- [instruction] Test memory")}\n\nHello, how are you?`;
    const result = stripRecallFromUserMessage(input);
    expect(typeof result).toBe("string");
    expect(result).not.toContain("<relevant-memories>");
    expect(result).toContain("Hello, how are you?");
  });

  it("preserves user-authored <relevant-memories> (no TencentDB preamble)", () => {
    const input = "<relevant-memories>\nSome user-written example\n</relevant-memories>\n\nHello!";
    const result = stripRecallFromUserMessage(input);
    expect(typeof result).toBe("string");
    expect(result).toContain("<relevant-memories>");
    expect(result).toContain("Some user-written example");
  });

  it("returns unchanged content when no injection present", () => {
    const input = "Hello, just a normal message.";
    const result = stripRecallFromUserMessage(input);
    expect(result).toBe(input);
  });

  it("handles empty string", () => {
    const result = stripRecallFromUserMessage("");
    expect(result).toBe("");
  });

  it("strips recall block when it is the entire message", () => {
    const input = makeRecallBlock("- [instruction] Test");
    const result = stripRecallFromUserMessage(input);
    expect(typeof result).toBe("string");
    expect((result as string).trim()).toBe("");
  });
});

// ======================================================
// stripRecallFromUserMessage — content parts
// ======================================================

describe("stripRecallFromUserMessage — content parts", () => {
  it("strips recall from text parts", () => {
    const input = [
      { type: "text", text: `${makeRecallBlock("- [instruction] Test memory")}\n\nHey!` },
    ];
    const result = stripRecallFromUserMessage(input);
    expect(Array.isArray(result)).toBe(true);
    const parts = result as Array<{ type: string; text?: string }>;
    expect(parts[0].text).not.toContain("<relevant-memories>");
    expect(parts[0].text).toContain("Hey!");
  });

  it("preserves non-text parts unchanged", () => {
    const input = [
      { type: "image", url: "http://example.com/img.png" },
      { type: "text", text: `${makeRecallBlock("- [instruction] Test")}\n\nQuery` },
    ];
    const result = stripRecallFromUserMessage(input);
    expect(Array.isArray(result)).toBe(true);
    const parts = result as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual(input[0]); // image part unchanged
    expect((parts[1] as { text: string }).text).not.toContain("<relevant-memories>");
  });

  it("returns original array when no injection present", () => {
    const input = [
      { type: "text", text: "Just a normal message" },
    ];
    const result = stripRecallFromUserMessage(input);
    expect(result).toBe(input); // same reference
  });

  it("handles parts with missing text field", () => {
    const input = [
      { type: "text" }, // no text field
      { type: "text", text: "Normal message" },
    ];
    const result = stripRecallFromUserMessage(input);
    expect(result).toBe(input); // unchanged
  });

  it("preserves user-authored <relevant-memories> in parts", () => {
    const input = [
      { type: "text", text: "<relevant-memories>\nUser example, no preamble\n</relevant-memories>" },
    ];
    const result = stripRecallFromUserMessage(input);
    const parts = result as Array<{ type: string; text?: string }>;
    expect(parts[0].text).toContain("<relevant-memories>");
  });
});

// ======================================================
// hasRecallInjection
// ======================================================

describe("hasRecallInjection", () => {
  it("returns true for string with TencentDB recall", () => {
    const input = makeRecallBlock("- [instruction] Test");
    expect(hasRecallInjection(input)).toBe(true);
  });

  it("returns false for string without recall", () => {
    expect(hasRecallInjection("Hello!")).toBe(false);
  });

  it("returns false for user-authored <relevant-memories> without preamble", () => {
    expect(hasRecallInjection("<relevant-memories>\nUser example\n</relevant-memories>")).toBe(false);
  });

  it("returns false for string with only preamble but no tag", () => {
    expect(hasRecallInjection(TENCENTDB_PREAMBLE)).toBe(false);
  });

  it("returns true for parts array with TencentDB recall", () => {
    const input = [
      { type: "text", text: makeRecallBlock("- [instruction] Test") },
    ];
    expect(hasRecallInjection(input)).toBe(true);
  });

  it("returns false for parts array without recall", () => {
    const input = [
      { type: "text", text: "Hello!" },
      { type: "image", url: "x" },
    ];
    expect(hasRecallInjection(input)).toBe(false);
  });

  it("returns false for non-text parts only", () => {
    const input = [{ type: "image", url: "x" }];
    expect(hasRecallInjection(input)).toBe(false);
  });
});
