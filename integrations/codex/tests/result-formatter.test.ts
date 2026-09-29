import { describe, expect, it } from "vitest";
import { ResultFormatter } from "../src/result-formatter.js";

describe("ResultFormatter", () => {
  it("formats recall with strategy and bounded context", () => {
    const formatter = new ResultFormatter(100);
    const text = formatter.recall({ context: "x".repeat(500), strategy: "hybrid", memory_count: 3 });
    expect(text).toContain("Strategy: hybrid");
    expect(text).toContain("Memory count: 3");
    expect(text).toContain("[Result truncated by the Codex adapter]");
  });
});
