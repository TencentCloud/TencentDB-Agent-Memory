import { describe, expect, it } from "vitest";
import { resolveAgentAdapter } from "../index.js";

const adapter = resolveAgentAdapter("dsh");
const titleMessages = [
  {
    role: "system",
    content: "Create a concise title for an AI coding-assistant session from the supplied human messages.",
  },
  { role: "user", content: 'Generate the session title from this JSON array: ["Find the nearest tag"]' },
];

describe("dsh request classification", () => {
  it("keeps title requests with the v0.2 client body out of the main conversation", () => {
    expect(adapter.classifyRequest({
      model: "deepseek-chat",
      stream: true,
      max_tokens: 4096,
      messages: titleMessages,
    })).toBe("auxiliary");
  });

  it("keeps the legacy title request classified as auxiliary", () => {
    expect(adapter.classifyRequest({
      max_tokens: 64,
      thinking: { type: "disabled" },
      messages: titleMessages,
    })).toBe("auxiliary");
  });

  it("keeps a genuine conversation without tools classified as main", () => {
    expect(adapter.classifyRequest({
      max_tokens: 4096,
      tools: [],
      messages: [
        { role: "system", content: "Help the user with their repository." },
        titleMessages[1],
      ],
    })).toBe("main");
  });

  it("keeps tool-bearing conversations classified as main even with the title prefix", () => {
    expect(adapter.classifyRequest({
      messages: titleMessages,
      tools: [{ type: "function", function: { name: "lookup" } }],
    })).toBe("main");
  });

  it("continues to treat explicit compaction requests as auxiliary", () => {
    expect(adapter.classifyRequest(
      { messages: [{ role: "user", content: "Summarize our work" }] },
      undefined,
      { "x-deepseek-harness-compact": "1" },
    )).toBe("auxiliary");
  });
});
