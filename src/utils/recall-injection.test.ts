import { describe, expect, it } from "vitest";

import {
  analyzeRecallInjectionImpact,
  buildInjectedUserText,
  stripRelevantMemoriesFromParts,
  stripRelevantMemoriesFromText,
} from "./recall-injection.js";

describe("recall injection helpers", () => {
  it("strips relevant memories from string content", () => {
    const text = "<relevant-memories>\n- A\n</relevant-memories>\n\nhello";

    const result = stripRelevantMemoriesFromText(text);

    expect(result.value).toBe("hello");
    expect(result.removedChars).toBeGreaterThan(0);
  });

  it("leaves clean string content unchanged", () => {
    const result = stripRelevantMemoriesFromText("hello");

    expect(result.value).toBe("hello");
    expect(result.removedChars).toBe(0);
  });

  it("strips only text parts that contain relevant memories", () => {
    const parts = [
      { type: "text", text: "<relevant-memories>\n- A\n</relevant-memories>\n\nhello" },
      { type: "image", source: "img" },
      { type: "text", text: "world" },
    ];

    const result = stripRelevantMemoriesFromParts(parts);

    expect(result.value).toEqual([
      { type: "text", text: "hello" },
      { type: "image", source: "img" },
      { type: "text", text: "world" },
    ]);
    expect(result.removedChars).toBeGreaterThan(0);
  });

  it("builds the effective user text with prependContext first", () => {
    expect(buildInjectedUserText({ userText: "task", prependContext: "<relevant-memories>\n- A\n</relevant-memories>" })).toBe(
      "<relevant-memories>\n- A\n</relevant-memories>\n\ntask",
    );
  });

  it("estimates extra persisted characters and dynamic prefix changes", () => {
    const result = analyzeRecallInjectionImpact([
      { userText: "first", prependContext: "<relevant-memories>\n- A\n</relevant-memories>" },
      { userText: "second", prependContext: "<relevant-memories>\n- B\n</relevant-memories>" },
      { userText: "third" },
    ]);

    expect(result.turns).toHaveLength(3);
    expect(result.extraPersistedChars).toBeGreaterThan(0);
    expect(result.prefixChangeCount).toBe(2);
    expect(result.totalPersistedCharsWithoutInjected).toBe("firstsecondthird".length);
  });

  it("does not count normal user text changes as injected prefix changes", () => {
    const result = analyzeRecallInjectionImpact([
      { userText: "first", prependContext: "<relevant-memories>\n- A\n</relevant-memories>" },
      { userText: "second", prependContext: "<relevant-memories>\n- A\n</relevant-memories>" },
    ]);

    expect(result.prefixChangeCount).toBe(0);
  });
});
