import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { extractUserQueryText } from "../common/user-query-extractor.js";

const MALFORMED_TAG_COUNT = 24_000;

describe("extractUserQueryText malformed tag handling", () => {
  it("keeps explicit user_query extraction semantics", () => {
    const raw = [
      "<system-reminder>noise</system-reminder>",
      "<user_query>first</user_query>",
      "<user_query>second</user_query>",
    ].join("\n");

    expect(extractUserQueryText(raw)).toBe("first\n\nsecond");
  });

  it("strips closed wrapper tags without disturbing adjacent user text", () => {
    const raw = [
      "<system-reminder>noise</system-reminder>",
      "keep me",
      "<tool_result>tool output</tool_result>",
    ].join("\n");

    expect(extractUserQueryText(raw)).toBe("keep me");
  });

  it("handles many unmatched user_query openings in linear time", () => {
    const input = "<user_query>".repeat(MALFORMED_TAG_COUNT);
    const started = performance.now();

    expect(extractUserQueryText(input)).toBe(input);
    expect(performance.now() - started).toBeLessThan(1_000);
  }, 5_000);

  it("handles many unmatched XML wrappers in linear time", () => {
    const input = "<system-reminder>".repeat(MALFORMED_TAG_COUNT);
    const started = performance.now();

    expect(extractUserQueryText(input)).toBe(input);
    expect(performance.now() - started).toBeLessThan(1_000);
  }, 5_000);
});
