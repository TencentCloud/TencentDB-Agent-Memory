import { describe, expect, it } from "vitest";

import {
  stripRelevantMemoriesFromMessage,
  stripRelevantMemoriesFromText,
} from "./recall-injection.js";

describe("recall injection stripping", () => {
  it("removes relevant memories from text and keeps the user prompt", () => {
    const input = [
      "<relevant-memories>",
      "- [episodic] repeated memory",
      "</relevant-memories>",
      "Please continue the task.",
    ].join("\n");

    const result = stripRelevantMemoriesFromText(input);

    expect(result.text).toBe("Please continue the task.");
    expect(result.removedChars).toBeGreaterThan(0);
  });

  it("strips only user messages", () => {
    const assistant = {
      role: "assistant",
      content: "<relevant-memories>\nsecret\n</relevant-memories>\nanswer",
    };

    expect(stripRelevantMemoriesFromMessage(assistant)).toBeUndefined();

    const user = {
      role: "user",
      content: "<relevant-memories>\nsecret\n</relevant-memories>\nquestion",
    };

    const result = stripRelevantMemoriesFromMessage(user);
    expect(result?.message.content).toBe("question");
  });

  it("strips text parts without touching non-text parts", () => {
    const message = {
      role: "user",
      content: [
        { type: "text", text: "<relevant-memories>\nsecret\n</relevant-memories>\nreal prompt" },
        { type: "image_url", image_url: { url: "https://example.test/image.png" } },
      ],
    };

    const result = stripRelevantMemoriesFromMessage(message);

    expect(result?.message.content).toEqual([
      { type: "text", text: "real prompt" },
      { type: "image_url", image_url: { url: "https://example.test/image.png" } },
    ]);
  });
});
