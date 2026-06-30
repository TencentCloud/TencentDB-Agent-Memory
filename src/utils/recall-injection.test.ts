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

  it("preserves injected recall when showInjected is enabled", () => {
    const message = {
      role: "user",
      content: "<relevant-memories>\nold memory\n</relevant-memories>\nActual prompt",
    };

    expect(stripInjectedRecallFromMessage(message, { showInjected: true })).toBeUndefined();
  });

  it("prevents multi-turn history growth by default while allowing explicit inspection", () => {
    const turns = [
      injectedUserMessage("First recalled memory block", "Plan the implementation."),
      injectedUserMessage("Second recalled memory block with different details", "Review the implementation."),
      injectedUserMessage("Third recalled memory block with final checks", "Draft the PR."),
    ];

    const defaultHistory = persistUserMessages(turns, false);
    const inspectionHistory = persistUserMessages(turns, true);

    expect(defaultHistory).toEqual([
      "Plan the implementation.",
      "Review the implementation.",
      "Draft the PR.",
    ]);
    expect(defaultHistory.join("\n")).not.toContain("<relevant-memories>");
    expect(inspectionHistory.join("\n")).toContain("<relevant-memories>");
    expect(inspectionHistory.join("\n")).toContain("Second recalled memory block with different details");
    expect(defaultHistory.join("\n").length).toBeLessThan(inspectionHistory.join("\n").length);
  });
});

function injectedUserMessage(memory: string, prompt: string): string {
  return [
    "<relevant-memories>",
    memory,
    "</relevant-memories>",
    prompt,
  ].join("\n");
}

function persistUserMessages(messages: string[], showInjected: boolean): string[] {
  return messages.map((content) => {
    const original = { role: "user", content };
    const stripped = stripInjectedRecallFromMessage(original, { showInjected });
    return (stripped?.message.content ?? original.content) as string;
  });
}
