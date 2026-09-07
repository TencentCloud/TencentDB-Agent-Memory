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

// ======================================================
// Markdown format stripping tests (UNIQUE differentiator)
// ======================================================

describe("stripRecallFromUserMessage — markdown wrapping", () => {
  const preamble = "以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：";
  const recallBlock = `<relevant-memories>\n${preamble}\n\n- [instruction] Test memory content\n</relevant-memories>`;

  it("strips recall block wrapped in fenced code block (```xml)", () => {
    const input = `\`\`\`xml\n${recallBlock}\n\`\`\`\n\nHello, how are you?`;
    const result = stripRecallFromUserMessage(input);
    expect(result).toBe("Hello, how are you?");
  });

  it("strips recall block wrapped in fenced code block without language tag", () => {
    const input = `\`\`\`\n${recallBlock}\n\`\`\`\n\nWhat is TypeScript?`;
    const result = stripRecallFromUserMessage(input);
    expect(result).toBe("What is TypeScript?");
  });

  it("strips recall block wrapped in inline code (single backtick)", () => {
    const input = `Here is a recall: \`${recallBlock}\` — anyway, my question is: deploy steps?`;
    const result = stripRecallFromUserMessage(input);
    expect(result).toBe("Here is a recall:  — anyway, my question is: deploy steps?");
  });

  it("strips recall block wrapped in markdown bold (**...**)", () => {
    const input = `**<relevant-memories>\n${preamble}\n\n- [instruction] Bold wrapped\n</relevant-memories>**\n\nReal question here`;
    const result = stripRecallFromUserMessage(input);
    expect(result).toBe("Real question here");
  });

  it("preserves user-authored code block when recall is in plain XML outside", () => {
    const userCode = "```\nconsole.log('hello')\n```";
    const input = `${userCode}\n\n${recallBlock}\n\nMy query`;
    const result = stripRecallFromUserMessage(input);
    expect(result).toContain("console.log('hello')");
    expect(result).toContain("My query");
    expect(result).not.toContain("<relevant-memories>");
  });

  it("strips when entire message is recall in code fence", () => {
    const input = `\`\`\`xml\n${recallBlock}\n\`\`\``;
    const result = stripRecallFromUserMessage(input);
    expect(typeof result === "string" ? result.trim() : result).toBe("");
  });

  it("preserves user code containing <relevant-memories> string (no preamble)", () => {
    // User writes code that happens to include the XML tag — should not be stripped
    const input = '```python\nprint("<relevant-memories>")\n```\n\nHello';
    const result = stripRecallFromUserMessage(input);
    expect(result).toContain("<relevant-memories>");
    expect(result).toContain("Hello");
  });

  // ═══ 扩展场景 — 吸收竞品 PR #319/#343/#351 优点 ═══

  it("handles nested <relevant-memories> tags (malicious)", () => {
    const preamble = "以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：";
    const nested = `<relevant-memories>${preamble}\n<relevant-memories>inner</relevant-memories>\nouter</relevant-memories>`;
    const result = stripRecallFromUserMessage(nested);
    // 应该正确剥离外层的 TencentDB 生成块
    expect(result).not.toContain("<relevant-memories>");
  });

  it("handles unclosed <relevant-memories> tag gracefully", () => {
    const preamble = "以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：";
    const unclosed = `Hello\n<relevant-memories>${preamble}\ncontent here but no close tag`;
    const result = stripRecallFromUserMessage(unclosed);
    // 没有闭合标签，整个 block 不应该被错误剥离
    expect(result).toContain("<relevant-memories>");
    expect(result).toContain("Hello");
  });

  it("handles very large recall content (50k+ chars)", () => {
    const preamble = "以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：";
    const longContent = "x".repeat(50_000);
    const input = `Hello\n<relevant-memories>${preamble}\n${longContent}\n</relevant-memories>\nQuestion`;

    const start = performance.now();
    const result = stripRecallFromUserMessage(input);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(50); // < 50ms for 50k+ chars
    expect(result).not.toContain("<relevant-memories>");
    expect(result).toContain("Hello");
    expect(result).toContain("Question");
  });

  it("strips recall from ContentPart[] with base64 image preservation", () => {
    const parts = [
      { type: "text", text: `Hello\n${recallBlock}\nQuestion` },
      { type: "image", source: { type: "base64", data: "aGVsbG8=" } },
      { type: "text", text: "Another text" },
    ];

    const result = stripRecallFromUserMessage(parts) as Array<{ type: string; text?: string }>;
    expect(result).toHaveLength(3);
    // Image part 不变
    expect(result[1]).toEqual(parts[1]);
    // Text part 被清理
    expect((result[0] as { text: string }).text).not.toContain("<relevant-memories>");
    expect((result[0] as { text: string }).text).toContain("Question");
  });

  it("hasRecallInjection and stripRecallFromUserMessage consistency", () => {
    // has=true → strip 后不再包含
    expect(hasRecallInjection(recallBlock)).toBe(true);
    const stripped = stripRecallFromUserMessage(recallBlock);
    expect(hasRecallInjection(stripped as string)).toBe(false);

    // has=false → strip 返回原值
    const plainText = "Just a normal message";
    expect(hasRecallInjection(plainText)).toBe(false);
    expect(stripRecallFromUserMessage(plainText)).toBe(plainText);
  });

  it("handles Unicode special characters in preamble gracefully", () => {
    // 中文 preamble 包含 Unicode 字符，strip 应正常工作
    const input = `你好\n${recallBlock}\n你好吗？`;
    const result = stripRecallFromUserMessage(input);
    expect(result).toContain("你好");
    expect(result).toContain("你好吗？");
    expect(result).not.toContain("<relevant-memories>");
  });

  it("handles fake injection block without preamble (should preserve)", () => {
    // 用户可能自己写 <relevant-memories> 标签（无 TencentDB preamble）
    const fakeBlock = "<relevant-memories>\nSome user-written notes\n</relevant-memories>\nMy real question";
    const result = stripRecallFromUserMessage(fakeBlock);
    expect(result).toContain("<relevant-memories>");
    expect(result).toContain("Some user-written notes");
    expect(result).toContain("My real question");
  });

  it("concurrent strip calls on same content produce consistent results", () => {
    const results = Array.from({ length: 10 }, () =>
      stripRecallFromUserMessage(recallBlock + "\nQuestion"),
    );
    // 所有结果应该一致
    const first = results[0];
    for (const r of results) {
      expect(r).toBe(first);
    }
  });
});
