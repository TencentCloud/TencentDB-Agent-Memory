import { describe, expect, it } from "vitest";
import { extractText } from "../drivers/common.js";

describe("driver common text extraction", () => {
  it("extracts Codex final responses", () => {
    expect(extractText({ finalResponse: "codex final" })).toBe("codex final");
  });

  it("extracts Claude Code result messages", () => {
    expect(extractText({ type: "result", subtype: "success", result: "claude final" })).toBe("claude final");
  });

  it("extracts array content blocks", () => {
    expect(extractText({
      content: [
        { type: "text", text: "hello " },
        { type: "text", text: "world" },
      ],
    })).toBe("hello world");
  });
});
