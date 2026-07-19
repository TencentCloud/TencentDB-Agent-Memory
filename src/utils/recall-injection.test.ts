import { describe, expect, it } from "vitest";
import { stripInjectedRecallFromMessage, stripInjectedRecallText } from "./recall-injection.js";

describe("recall injection stripping", () => {
  it("removes relevant memories from user string content", () => {
    const text = [
      "<relevant-memories>",
      "memory recall:",
      "- [instruction|work] User prefers concise updates.",
      "</relevant-memories>",
      "Please summarize the task.",
    ].join("\n");

    expect(stripInjectedRecallText(text)).toBe("Please summarize the task.");
  });

  it("leaves ordinary text unchanged", () => {
    expect(stripInjectedRecallText("Please summarize the task.")).toBe("Please summarize the task.");
  });

  it("keeps persisted user prompts stable when recalled memories differ", () => {
    const first = [
      "<relevant-memories>",
      "- memory A",
      "</relevant-memories>",
      "Please summarize the task.",
    ].join("\n");
    const second = [
      "<relevant-memories>",
      "- memory B with different length and content",
      "</relevant-memories>",
      "Please summarize the task.",
    ].join("\n");

    expect(stripInjectedRecallText(first)).toBe(stripInjectedRecallText(second));
  });

  it("removes the recall-only tools guide together with its injected memories", () => {
    const text = [
      "<memory-tdai-auto-recall>",
      "<relevant-memories>",
      "- recalled memory",
      "</relevant-memories>",
      "<memory-tools-guide>",
      "Use tdai_memory_search when needed.",
      "</memory-tools-guide>",
      "</memory-tdai-auto-recall>",
      "Actual user prompt.",
    ].join("\n");

    expect(stripInjectedRecallText(text)).toBe("Actual user prompt.");
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
