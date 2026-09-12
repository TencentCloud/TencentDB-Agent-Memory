import { describe, expect, it } from "vitest";
import { formatPiAgentMemoryContext } from "./context.js";

describe("formatPiAgentMemoryContext", () => {
  it("formats recall context for Pi Agent injection", () => {
    const context = formatPiAgentMemoryContext({
      recall: { context: "remember cobalt", strategy: "keyword", memory_count: 1 },
      maxChars: 1000,
    });

    expect(context).toContain("Long-term Memory Recall for Pi Agent");
    expect(context).toContain("strategy=keyword");
    expect(context).toContain("remember cobalt");
  });

  it("returns empty string when recall has no context", () => {
    expect(formatPiAgentMemoryContext({ recall: { context: "" }, maxChars: 1000 })).toBe("");
  });
});