import { describe, expect, it } from "vitest";
import { formatClaudeCodeAdditionalContext } from "./context-format.js";

describe("formatClaudeCodeAdditionalContext", () => {
  it("formats long-term recall and short-term canvas separately", () => {
    const text = formatClaudeCodeAdditionalContext({
      recall: { context: "User likes concise answers.", strategy: "hybrid", memory_count: 2 },
      shortTermCanvas: "graph TD\n  A-->B",
      options: { recallMaxChars: 1000, canvasMaxChars: 1000 },
    });

    expect(text).toContain("Long-term Recall");
    expect(text).toContain("Short-term Task Canvas");
    expect(text).toContain("memory_count=2");
    expect(text).toContain("User likes concise answers.");
  });

  it("returns empty string when there is no context", () => {
    expect(formatClaudeCodeAdditionalContext({
      recall: { context: "" },
      options: { recallMaxChars: 1000, canvasMaxChars: 1000 },
    })).toBe("");
  });
});

