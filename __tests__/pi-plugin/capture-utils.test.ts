import { describe, expect, it } from "vitest";

import {
  contentToText,
  extractRound,
} from "../../pi-plugin/tdai-memory/capture-utils.js";

describe("contentToText", () => {
  it("passes plain string content through", () => {
    expect(contentToText("hello")).toBe("hello");
  });

  it("joins text blocks and ignores non-text blocks", () => {
    expect(
      contentToText([
        { type: "text", text: "line one" },
        { type: "image", data: "..." },
        { type: "text", text: "line two" },
      ]),
    ).toBe("line one\nline two");
  });

  it("returns empty string for undefined / non-array content", () => {
    expect(contentToText(undefined)).toBe("");
    expect(contentToText(42)).toBe("");
    expect(contentToText({ type: "text", text: "not-an-array" })).toBe("");
  });
});

describe("extractRound", () => {
  it("extracts the last user message and the assistant reply after it", () => {
    const round = extractRound([
      { role: "user", content: "earlier question" },
      { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
      { role: "user", content: "current question" },
      { role: "assistant", content: [{ type: "text", text: "current answer" }] },
    ]);
    expect(round.userContent).toBe("current question");
    expect(round.assistantContent).toBe("current answer");
  });

  it("concatenates multiple assistant messages after the last user message", () => {
    const round = extractRound([
      { role: "user", content: "question" },
      { role: "assistant", content: [{ type: "text", text: "thinking done, calling tool" }] },
      { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
      { role: "assistant", content: [{ type: "text", text: "final answer" }] },
    ]);
    expect(round.userContent).toBe("question");
    expect(round.assistantContent).toBe("thinking done, calling tool\nfinal answer");
  });

  it("excludes toolResult and custom messages from the captured round", () => {
    const round = extractRound([
      { role: "user", content: "question" },
      { role: "custom", content: "[recalled memories] user likes Rust" },
      { role: "toolResult", content: [{ type: "text", text: "secret tool output" }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ]);
    expect(round.assistantContent).toBe("answer");
    expect(round.assistantContent).not.toContain("secret tool output");
    expect(round.assistantContent).not.toContain("recalled memories");
  });

  it("returns empty round when there is no user message", () => {
    expect(extractRound([{ role: "assistant", content: "orphan answer" }])).toEqual({
      userContent: "",
      assistantContent: "",
    });
    expect(extractRound([])).toEqual({ userContent: "", assistantContent: "" });
  });

  it("skips assistant messages with only non-text content", () => {
    const round = extractRound([
      { role: "user", content: "question" },
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash" }] },
      { role: "assistant", content: [{ type: "text", text: "real answer" }] },
    ]);
    expect(round.assistantContent).toBe("real answer");
  });
});
