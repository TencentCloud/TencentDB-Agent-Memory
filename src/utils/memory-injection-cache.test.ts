import { describe, expect, it } from "vitest";

import {
  MEMORY_OMITTED_MARKER,
  compactRelevantMemoriesInMessage,
  compactRelevantMemoriesText,
  prepareMessagesForPromptCache,
} from "./memory-injection-cache.js";

describe("memory injection prompt-cache preparation", () => {
  it("compacts relevant memory blocks in string content", () => {
    const result = compactRelevantMemoriesText(
      `<relevant-memories>\n- [episodic] noisy recalled fact\n</relevant-memories>\nPlease continue the task.`,
    );

    expect(result.changed).toBe(true);
    expect(result.text).toBe(`${MEMORY_OMITTED_MARKER}\nPlease continue the task.`);
    expect(result.text).not.toContain("noisy recalled fact");
    expect(result.removedChars).toBeGreaterThan(0);
  });

  it("compacts only text parts in multimodal message content", () => {
    const imagePart = { type: "image", image: "data:image/png;base64,abc" };
    const message = {
      role: "user",
      content: [
        {
          type: "text",
          text: `hello\n<relevant-memories>\n- volatile memory\n</relevant-memories>\nworld`,
        },
        imagePart,
      ],
    };

    const result = compactRelevantMemoriesInMessage(message);
    const parts = result.message.content as Array<{ type: string; text?: string; image?: string }>;

    expect(result.changed).toBe(true);
    expect(result.textPartsChanged).toBe(1);
    expect(parts[0].text).toBe(`hello\n${MEMORY_OMITTED_MARKER}\nworld`);
    expect(parts[0].text).not.toContain("volatile memory");
    expect(parts[1]).toBe(imagePart);
  });

  it("dedupes repeated system messages while compacting historical memory", () => {
    const messages = [
      { role: "system", content: "stable system instructions" },
      {
        role: "user",
        content: `<relevant-memories>\n- turn-specific memory\n</relevant-memories>\nWhat changed?`,
      },
      { role: "assistant", content: "A short answer." },
      { role: "system", content: "stable system instructions" },
      { role: "system", content: "different system instructions" },
    ];

    const prepared = prepareMessagesForPromptCache(messages);

    expect(prepared.compacted.messagesChanged).toBe(1);
    expect(prepared.dedupedSystemMessages).toBe(1);
    expect(prepared.messages).toHaveLength(4);
    expect(prepared.messages.map((message) => message.content)).toEqual([
      "stable system instructions",
      `${MEMORY_OMITTED_MARKER}\nWhat changed?`,
      "A short answer.",
      "different system instructions",
    ]);
  });

  it("normalizes different recalled-memory histories to the same cache prefix", () => {
    const sessionA = [
      { role: "system", content: "stable system instructions" },
      {
        role: "user",
        content: `<relevant-memories>\n- alpha-only memory\n</relevant-memories>\nContinue.`,
      },
    ];
    const sessionB = [
      { role: "system", content: "stable system instructions" },
      {
        role: "user",
        content: `<relevant-memories>\n- beta-only memory\n</relevant-memories>\nContinue.`,
      },
    ];

    expect(JSON.stringify(sessionA)).not.toBe(JSON.stringify(sessionB));

    const preparedA = prepareMessagesForPromptCache(sessionA).messages;
    const preparedB = prepareMessagesForPromptCache(sessionB).messages;

    expect(JSON.stringify(preparedA)).toBe(JSON.stringify(preparedB));
  });

  it("leaves messages unchanged when there is no injected memory", () => {
    const message = { role: "user", content: "plain prompt" };
    const result = compactRelevantMemoriesInMessage(message);

    expect(result.changed).toBe(false);
    expect(result.message).toBe(message);
  });
});
