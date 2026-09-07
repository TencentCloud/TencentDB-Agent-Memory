import { describe, expect, it } from "vitest";

import { stripInjectedRecallFromMessage } from "./recall-injection.js";

const TURN_COUNT = 100;
const RECALL_CHARS_PER_TURN = 1_000;

function injectedTurn(turn: number) {
  const question = `Question ${turn}: continue the task`;
  const memory = `${turn}:`.padEnd(RECALL_CHARS_PER_TURN, String(turn % 10));
  return {
    question,
    message: {
      role: "user",
      content: `<relevant-memories>\n${memory}\n</relevant-memories>\n\n${question}`,
    },
  };
}

describe("recall injection multi-turn history growth", () => {
  it("keeps persisted string history bounded across 100 dynamic recalls", () => {
    const visibleHistory: string[] = [];
    const cleanedHistory: string[] = [];
    let strippedChars = 0;

    for (let turn = 1; turn <= TURN_COUNT; turn += 1) {
      const { question, message } = injectedTurn(turn);
      visibleHistory.push(message.content);

      const cleaned = stripInjectedRecallFromMessage(message, false);
      expect(cleaned, `turn ${turn} should contain removable recall`).toBeDefined();
      cleanedHistory.push(String(cleaned?.message.content));
      strippedChars += cleaned?.strippedChars ?? 0;
      expect(cleaned?.message.content).toBe(question);
    }

    const visibleChars = visibleHistory.join("\n").length;
    const cleanedChars = cleanedHistory.join("\n").length;

    expect(visibleHistory.join("\n")).toContain("<relevant-memories>");
    expect(cleanedHistory.join("\n")).not.toContain("<relevant-memories>");
    expect(strippedChars).toBe(visibleChars - cleanedChars);
    expect(strippedChars).toBeGreaterThanOrEqual(TURN_COUNT * RECALL_CHARS_PER_TURN);
    expect(cleanedChars).toBeLessThan(visibleChars * 0.05);
  });

  it("preserves non-text parts while bounding multipart history growth", () => {
    const persisted: Array<Array<Record<string, unknown>>> = [];

    for (let turn = 1; turn <= 50; turn += 1) {
      const { message, question } = injectedTurn(turn);
      const imagePart = {
        type: "image_url",
        image_url: { url: `https://example.com/${turn}.png` },
      };
      const multipart = {
        role: "user",
        content: [
          { type: "text", text: message.content },
          imagePart,
        ],
      };

      const cleaned = stripInjectedRecallFromMessage(multipart, false);
      expect(cleaned?.message.content).toEqual([
        { type: "text", text: question },
        imagePart,
      ]);
      persisted.push(cleaned?.message.content as Array<Record<string, unknown>>);
    }

    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain("relevant-memories");
    expect(serialized).toContain("https://example.com/1.png");
    expect(serialized).toContain("https://example.com/50.png");
  });

  it("does not rewrite messages when injected history is explicitly visible", () => {
    for (let turn = 1; turn <= TURN_COUNT; turn += 1) {
      const { message } = injectedTurn(turn);
      expect(stripInjectedRecallFromMessage(message, true)).toBeUndefined();
    }
  });
});
