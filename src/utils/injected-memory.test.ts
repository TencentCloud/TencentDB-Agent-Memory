import { describe, expect, test } from "vitest";
import {
  commonPrefixChars,
  estimatePrefixReuse,
  estimateInjectedHistoryChars,
  stripInjectedRelevantMemoriesFromContent,
  stripInjectedRelevantMemoriesFromText,
} from "./injected-memory.js";

describe("injected memory cleanup", () => {
  test("removes relevant memories from a persisted string user message", () => {
    const content = [
      "<relevant-memories>",
      "memory line 1",
      "memory line 2",
      "</relevant-memories>",
      "What should I do next?",
    ].join("\n");

    expect(stripInjectedRelevantMemoriesFromText(content)).toBe("What should I do next?");
  });

  test("removes injected text parts and preserves non-text parts", () => {
    const content = [
      {
        type: "text",
        text: "<relevant-memories>\nold memory\n</relevant-memories>\n",
      },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,abc" },
      },
      {
        type: "text",
        text: "Continue the task",
      },
    ];

    expect(stripInjectedRelevantMemoriesFromContent(content)).toEqual([
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,abc" },
      },
      {
        type: "text",
        text: "Continue the task",
      },
    ]);
  });

  test("reports the showInjected history bloat avoided by stripping", () => {
    const turns = [
      {
        role: "user",
        content: "<relevant-memories>\n".concat("a".repeat(500), "\n</relevant-memories>\nturn 1"),
      },
      {
        role: "assistant",
        content: "ok",
      },
      {
        role: "user",
        content: "<relevant-memories>\n".concat("b".repeat(700), "\n</relevant-memories>\nturn 2"),
      },
    ];

    expect(estimateInjectedHistoryChars(turns)).toEqual({
      beforeChars: 1298,
      afterChars: 14,
      removedChars: 1284,
      removedBlocks: 2,
    });
  });

  test("improves reusable prompt prefix when history is tail-truncated", () => {
    const stableSystem = "system:".concat("s".repeat(1100));
    const historyBudgetChars = 320;
    const injectedA = "<relevant-memories>\n".concat("a".repeat(600), "\n</relevant-memories>\nfirst turn");
    const injectedB = "<relevant-memories>\n".concat("b".repeat(700), "\n</relevant-memories>\nsecond turn");
    const injectedC = "<relevant-memories>\n".concat("c".repeat(500), "\n</relevant-memories>\nthird turn");

    const buildPrompt = (
      history: Array<{ role: "user" | "assistant"; content: string }>,
      currentUser: string,
    ) => {
      const historyText = history.map((m) => `${m.role}:${m.content}`).join("\n");
      const tailHistory = historyText.length > historyBudgetChars
        ? historyText.slice(historyText.length - historyBudgetChars)
        : historyText;
      return `${stableSystem}\n${tailHistory}\nuser:${currentUser}`;
    };

    const pollutedTurn2 = buildPrompt(
      [
        { role: "user", content: injectedA },
        { role: "assistant", content: "assistant one" },
      ],
      injectedB,
    );
    const pollutedTurn3 = buildPrompt(
      [
        { role: "user", content: injectedA },
        { role: "assistant", content: "assistant one" },
        { role: "user", content: injectedB },
        { role: "assistant", content: "assistant two" },
      ],
      injectedC,
    );

    const cleanTurn2 = buildPrompt(
      [
        { role: "user", content: stripInjectedRelevantMemoriesFromText(injectedA) },
        { role: "assistant", content: "assistant one" },
      ],
      injectedB,
    );
    const cleanTurn3 = buildPrompt(
      [
        { role: "user", content: stripInjectedRelevantMemoriesFromText(injectedA) },
        { role: "assistant", content: "assistant one" },
        { role: "user", content: stripInjectedRelevantMemoriesFromText(injectedB) },
        { role: "assistant", content: "assistant two" },
      ],
      injectedC,
    );

    const pollutedPrefix = commonPrefixChars(pollutedTurn2, pollutedTurn3);
    const cleanPrefix = commonPrefixChars(cleanTurn2, cleanTurn3);
    const pollutedReuse = estimatePrefixReuse(pollutedTurn2, pollutedTurn3);
    const cleanReuse = estimatePrefixReuse(cleanTurn2, cleanTurn3);

    expect(pollutedPrefix).toBe(1108);
    expect(cleanPrefix).toBe(1153);
    expect(cleanPrefix - pollutedPrefix).toBe(45);
    expect(pollutedReuse.reuseRatio).toBeCloseTo(0.5579, 4);
    expect(cleanReuse.reuseRatio).toBeCloseTo(0.6604, 4);
    expect(cleanReuse.reuseRatio).toBeGreaterThan(pollutedReuse.reuseRatio);
  });
});
