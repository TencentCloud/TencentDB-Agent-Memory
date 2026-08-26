import { describe, expect, it } from "vitest";
import { isPiSummaryRequest, piAdapter } from "../pi.js";

const summarySystem = "You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then summarize it.";

describe("piAdapter", () => {
  it("classifies only Pi's strict summary shape as auxiliary", () => {
    const summary = { messages: [
      { role: "system", content: summarySystem },
      { role: "user", content: "<conversation>history</conversation>" },
    ] };
    expect(isPiSummaryRequest(summary)).toBe(true);
    expect(piAdapter.classifyRequest(summary)).toBe("auxiliary");
    expect(isPiSummaryRequest({ ...summary, tools: [{ type: "function" }] })).toBe(false);
    expect(isPiSummaryRequest({ messages: [...summary.messages, { role: "user", content: "real" }] })).toBe(false);
  });

  it("keeps unknown requests on the main path", () => {
    expect(piAdapter.classifyRequest({ messages: [{ role: "user", content: "hello" }] })).toBe("main");
  });

  it("extracts string and text-block content without applying weak summary signals", () => {
    expect(piAdapter.extractUserText(" hello ")).toBe("hello");
    expect(piAdapter.extractUserText("<conversation>x</conversation>")).toBe("<conversation>x</conversation>");
    expect(piAdapter.extractUserText([{ type: "text", text: "from block" }])).toBe("from block");
  });

  it("accepts Pi's developer-role and text-block summary variant", () => {
    expect(isPiSummaryRequest({
      messages: [
        { role: "developer", content: [{ type: "text", text: summarySystem }] },
        { role: "user", content: [{ type: "text", text: "  <conversation>history</conversation>" }] },
      ],
      tools: [],
    })).toBe(true);
  });

  it("keeps malformed near-matches on the main path", () => {
    expect(isPiSummaryRequest({
      messages: [{ role: "user", content: "<conversation>real user XML</conversation>" }],
    })).toBe(false);
    expect(isPiSummaryRequest({
      messages: [
        { role: "system", content: summarySystem },
        { role: "user", content: "<conversation>history" },
      ],
    })).toBe(false);
    expect(isPiSummaryRequest({
      messages: [
        { role: "system", content: summarySystem },
        { role: "assistant", content: "<conversation>history</conversation>" },
      ],
    })).toBe(false);
  });
});
