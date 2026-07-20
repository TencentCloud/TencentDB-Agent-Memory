import { describe, expect, it } from "vitest";
import { stripInjectedRecallFromMessage, stripInjectedRecallText } from "./recall-injection.js";

describe("recall injection stripping", () => {
  it("removes relevant memories from user string content", () => {
    const text = [
      "<relevant-memories>",
      "记忆召回：",
      "- [instruction|work] User prefers concise updates.",
      "</relevant-memories>",
      "Please summarize the task.",
    ].join("\n");

    expect(stripInjectedRecallText(text)).toBe("Please summarize the task.");
  });

  it("leaves ordinary text unchanged", () => {
    expect(stripInjectedRecallText("Please summarize the task.")).toBe("Please summarize the task.");
  });

  it("removes relevant memories from text parts only", () => {
    const result = stripInjectedRecallFromMessage({
      role: "user",
      content: [
        { type: "text", text: "<relevant-memories>\nold memory\n</relevant-memories>\nActual prompt" },
        { type: "image", data: "abc" },
      ],
    });

    expect(result?.message.content).toEqual([
      { type: "text", text: "Actual prompt" },
      { type: "image", data: "abc" },
    ]);
    expect(result?.strippedChars).toBeGreaterThan(0);
  });

  it("does not strip assistant messages", () => {
    const result = stripInjectedRecallFromMessage({
      role: "assistant",
      content: "<relevant-memories>\nold memory\n</relevant-memories>\nAnswer",
    });

    expect(result).toBeUndefined();
  });
});
