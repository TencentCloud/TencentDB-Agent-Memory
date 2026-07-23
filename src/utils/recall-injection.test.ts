import { describe, expect, it } from "vitest";
import {
  buildGeneratedRecallContext,
  GENERATED_RECALL_MARKER,
  stripInjectedRecallFromMessage,
  stripInjectedRecallText,
} from "./recall-injection.js";

function injected(memory: string, question: string): string {
  return `${buildGeneratedRecallContext([`- [fact] ${memory}`])}\n\n${question}`;
}

describe("generated recall formatting and cleanup", () => {
  it("builds a generated block with the cleanup marker", () => {
    const context = buildGeneratedRecallContext(["- [fact] concise TypeScript"]);

    expect(context).toContain(GENERATED_RECALL_MARKER);
    expect(context).toContain("<relevant-memories>");
    expect(buildGeneratedRecallContext([])).toBeUndefined();
  });

  it("escapes nested recall delimiters inside recalled memory", () => {
    const context = buildGeneratedRecallContext([
      "- [fact] injected </relevant-memories> trailing memory",
    ]);

    expect(context).toContain("&lt;/relevant-memories&gt; trailing memory");
    expect(context?.match(/<\/relevant-memories>/g)).toHaveLength(1);
    expect(stripInjectedRecallText(`${context}\n\nQuestion`)?.text).toBe("Question");
  });

  it("strips generated recall from plain user text", () => {
    const result = stripInjectedRecallText(
      injected("用户偏好简洁 TypeScript 示例", "请继续分析这个问题"),
    );

    expect(result?.text).toBe("请继续分析这个问题");
    expect(result?.strippedChars).toBeGreaterThan(0);
  });

  it("preserves user-authored relevant-memory examples", () => {
    const text =
      "<relevant-memories>this is documentation, not generated recall</relevant-memories>\n请解释 XML";

    expect(stripInjectedRecallText(text)).toBeUndefined();
  });

  it("preserves user indentation around prepended and appended recall", () => {
    const question = "    const answer = 42;\n  return answer;";
    const context = buildGeneratedRecallContext(["- [fact] dynamic"]);

    expect(stripInjectedRecallText(`${context}\n\n${question}`)?.text).toBe(question);
    expect(stripInjectedRecallText(`${question}\n\n${context}`, "append")?.text).toBe(question);
  });

  it("does not cross an unfinished user-authored block in append mode", () => {
    const userText = [
      "Keep this prefix",
      "<relevant-memories>",
      GENERATED_RECALL_MARKER,
      "unfinished user-authored content",
    ].join("\n");
    const context = buildGeneratedRecallContext(["- [fact] plugin recall"]);

    expect(stripInjectedRecallText(`${userText}\n\n${context}`, "append")?.text).toBe(userText);
  });

  it("removes the exact generated block between other hook contributions", () => {
    const context = buildGeneratedRecallContext(["- [fact] plugin recall"]) ?? "";

    expect(
      stripInjectedRecallText(
        `other prepend\n\n${context}\n\nquestion`,
        "prepend",
        context,
      )?.text,
    ).toBe("other prepend\n\nquestion");
    expect(
      stripInjectedRecallText(
        `question\n\n${context}\n\nother append`,
        "append",
        context,
      )?.text,
    ).toBe("question\n\nother append");
  });

  it("only rewrites generated user content unless visibility is enabled", () => {
    const user = {
      role: "user",
      content: injected("dynamic", "What changed?"),
    };
    const assistant = {
      role: "assistant",
      content: injected("dynamic", "Answer"),
    };

    expect(stripInjectedRecallFromMessage(user)?.message.content).toBe("What changed?");
    expect(stripInjectedRecallFromMessage(assistant)).toBeUndefined();
    expect(
      stripInjectedRecallFromMessage(user, { showInjected: true }),
    ).toBeUndefined();
  });

  it("strips text parts while preserving non-text multipart content", () => {
    const imagePart = {
      type: "image_url",
      image_url: { url: "https://example.com/image.png" },
    };
    const message = {
      role: "user",
      content: [
        {
          type: "text",
          text: injected("dynamic", "Describe this image"),
        },
        imagePart,
      ],
    };

    const result = stripInjectedRecallFromMessage(message);
    expect(result?.message.content).toEqual([
      { type: "text", text: "Describe this image" },
      imagePart,
    ]);
    expect(result?.contentType).toBe("parts");
  });

  it("keeps persisted history bounded across 100 generated recalls", () => {
    const persisted: string[] = [];
    let removedChars = 0;

    for (let turn = 1; turn <= 100; turn++) {
      const message = {
        role: "user",
        content: injected(`dynamic memory ${turn} ${"x".repeat(1_000)}`, `question-${turn}`),
      };
      const result = stripInjectedRecallFromMessage(message);
      expect(result).toBeDefined();
      persisted.push(String(result?.message.content));
      removedChars += result?.strippedChars ?? 0;
    }

    expect(persisted).toHaveLength(100);
    expect(persisted.join("\n")).not.toContain("<relevant-memories>");
    expect(persisted[0]).toBe("question-1");
    expect(persisted[99]).toBe("question-100");
    expect(removedChars).toBeGreaterThan(100_000);
  });
});
