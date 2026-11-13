import { describe, expect, it } from "vitest";

import {
  escapeXmlTags,
  pickRecentUnique,
  sanitizeText,
  stripCodeBlocks,
} from "./sanitize.js";

describe("stripCodeBlocks", () => {
  it("removes fenced code blocks and collapses blank lines", () => {
    const input = "before\n```ts\nconst x = 1;\n```\n\n\n\nafter";
    expect(stripCodeBlocks(input)).toBe("before\n\nafter");
  });

  it("leaves plain text otherwise intact", () => {
    expect(stripCodeBlocks("  hello world  ")).toBe("hello world");
  });
});

describe("sanitizeText", () => {
  it("removes injected memory context tags", () => {
    const text = "<relevant-memories>secret context</relevant-memories>real question";
    expect(sanitizeText(text)).not.toContain("secret context");
    expect(sanitizeText(text)).toContain("real question");
  });

  it("removes user persona blocks", () => {
    const out = sanitizeText("<user-persona>persona</user-persona>keep");
    expect(out).toContain("keep");
    // Without this the assertion also passes when the persona body is left in place.
    expect(out).not.toContain("persona");
  });

  it("removes other injected context blocks", () => {
    const out = sanitizeText("<relevant-scenes>hidden</relevant-scenes>question");
    expect(out).toContain("question");
    expect(out).not.toContain("hidden");
  });
});

describe("pickRecentUnique", () => {
  it("returns the most recent unique entries in original order", () => {
    expect(pickRecentUnique(["a", "b", "a", "c"], 3)).toEqual(["b", "a", "c"]);
  });

  it("respects the max limit", () => {
    expect(pickRecentUnique(["a", "b", "c"], 2)).toEqual(["b", "c"]);
  });

  it("handles empty input", () => {
    expect(pickRecentUnique([], 5)).toEqual([]);
  });
});

describe("escapeXmlTags", () => {
  it("escapes known section boundaries", () => {
    expect(escapeXmlTags("</user-persona>")).toBe("&lt;/user-persona&gt;");
  });

  it("leaves unrelated tags untouched", () => {
    expect(escapeXmlTags("<b>bold</b>")).toBe("<b>bold</b>");
  });
});
