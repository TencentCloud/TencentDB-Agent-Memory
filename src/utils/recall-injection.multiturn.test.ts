import { describe, expect, it } from "vitest";
import {
  buildGeneratedRecallContext,
  stripInjectedRecallFromMessage,
} from "./recall-injection.js";

const LONG_TURN_COUNT = 100;

function recallForTurn(turn: number): string {
  return buildGeneratedRecallContext([
    `- [fact] dynamic memory ${turn} ${"x".repeat(1_000)}`,
  ]) ?? "";
}

describe("recall injection long-session matrix", () => {
  it("keeps append-mode string history bounded across 100 turns", () => {
    const persisted: string[] = [];

    for (let turn = 1; turn <= LONG_TURN_COUNT; turn++) {
      const result = stripInjectedRecallFromMessage(
        {
          role: "user",
          content: `question-${turn}\n\n${recallForTurn(turn)}`,
        },
        { placement: "append" },
      );
      persisted.push(String(result?.message.content));
    }

    expect(persisted).toHaveLength(LONG_TURN_COUNT);
    expect(persisted.join("\n")).not.toContain("<relevant-memories>");
    expect(persisted[0]).toBe("question-1");
    expect(persisted[99]).toBe("question-100");
  });

  it("keeps multipart history bounded while preserving image parts", () => {
    const persisted: unknown[] = [];

    for (let turn = 1; turn <= 50; turn++) {
      const imagePart = {
        type: "image_url",
        image_url: { url: `https://example.com/${turn}.png` },
      };
      const result = stripInjectedRecallFromMessage(
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `question-${turn}\n\n${recallForTurn(turn)}`,
            },
            imagePart,
          ],
        },
        { placement: "append" },
      );
      persisted.push(result?.message.content);
      expect(result?.message.content).toEqual([
        { type: "text", text: `question-${turn}` },
        imagePart,
      ]);
    }

    expect(JSON.stringify(persisted)).not.toContain("<relevant-memories>");
  });

  it("documents intentional growth when showInjected is enabled", () => {
    const persisted: string[] = [];

    for (let turn = 1; turn <= LONG_TURN_COUNT; turn++) {
      const content = `question-${turn}\n\n${recallForTurn(turn)}`;
      const result = stripInjectedRecallFromMessage(
        { role: "user", content },
        { placement: "append", showInjected: true },
      );
      expect(result).toBeUndefined();
      persisted.push(content);
    }

    const history = persisted.join("\n");
    expect(history.match(/<relevant-memories>/g)).toHaveLength(LONG_TURN_COUNT);
    expect(history.length).toBeGreaterThan(100_000);
  });
});

