import { describe, expect, it } from "vitest";

import { SessionFilter, isNonInteractiveTrigger } from "./session-filter.js";

/**
 * The exclusion patterns only support `*` as a wildcard. Every other regex
 * metacharacter must reach `new RegExp()` escaped, otherwise a configured
 * pattern either matches too broadly or fails to compile at startup.
 */
describe("SessionFilter glob patterns", () => {
  it("treats '?' as a literal character instead of a quantifier", () => {
    const filter = new SessionFilter(["review?"]);
    expect(filter.shouldSkip("review?")).toBe(true);
    expect(filter.shouldSkip("revie")).toBe(false);
    expect(filter.shouldSkip("review")).toBe(false);
    expect(filter.shouldSkip("reviewX")).toBe(false);
  });

  it("accepts patterns starting with '?' without throwing", () => {
    expect(() => new SessionFilter(["?", "?tmp"])).not.toThrow();

    const anyQuestionMark = new SessionFilter(["?"]);
    expect(anyQuestionMark.shouldSkip("sess:a?b")).toBe(true);
    expect(anyQuestionMark.shouldSkip("sess:abc")).toBe(false);

    const leadingQuestionMark = new SessionFilter(["?tmp"]);
    expect(leadingQuestionMark.shouldSkip("sess:?tmp")).toBe(true);
    expect(leadingQuestionMark.shouldSkip("sess:tmp")).toBe(false);
  });

  it("keeps '?' literal when combined with the '*' wildcard", () => {
    const filter = new SessionFilter(["run?-*"]);
    expect(filter.shouldSkip("sess:run?-42")).toBe(true);
    expect(filter.shouldSkip("sess:run-42")).toBe(false);
  });

  it("still expands '*' as the only wildcard", () => {
    const filter = new SessionFilter(["bench-judge-*"]);
    expect(filter.shouldSkip("main:bench-judge-7")).toBe(true);
    expect(filter.shouldSkip("main:other-7")).toBe(false);
  });

  it("keeps the remaining regex metacharacters literal", () => {
    const cases: Array<[string, string, string]> = [
      ["a.b", "a.b", "axb"],
      ["a+b", "a+b", "aaab"],
      ["x(y)", "x(y)", "xy"],
      ["x[y]", "x[y]", "xy"],
      ["a\\b", "a\\b", "ab"],
    ];
    for (const [pattern, matches, doesNotMatch] of cases) {
      const filter = new SessionFilter([pattern]);
      expect(filter.shouldSkip(matches)).toBe(true);
      expect(filter.shouldSkip(doesNotMatch)).toBe(false);
    }
  });

  it("ignores blank entries and trims surrounding whitespace", () => {
    expect(new SessionFilter(["", "   "]).shouldSkip("main:normal")).toBe(false);
    expect(new SessionFilter(["  exact  "]).shouldSkip("main:exact")).toBe(true);
  });

  it("keeps the built-in skip rules", () => {
    const filter = new SessionFilter([]);
    expect(filter.shouldSkip("main:subagent:abc")).toBe(true);
    expect(filter.shouldSkip("temp:slug-generator")).toBe(true);
    expect(filter.shouldSkip("main:memory-scene-extract-x")).toBe(true);
    expect(filter.shouldSkip("main:normal")).toBe(false);
  });
});

describe("SessionFilter.shouldSkipCtx", () => {
  it("skips contexts without a session key", () => {
    expect(new SessionFilter([]).shouldSkipCtx({})).toBe(true);
  });

  it("skips internal session ids and non-interactive triggers", () => {
    const filter = new SessionFilter([]);
    expect(filter.shouldSkipCtx({ sessionKey: "main:x", sessionId: "memory-1" })).toBe(true);
    expect(filter.shouldSkipCtx({ sessionKey: "main:x", trigger: "cron" })).toBe(true);
    expect(filter.shouldSkipCtx({ sessionKey: "main:subagent:x" })).toBe(true);
    expect(filter.shouldSkipCtx({ sessionKey: "main:x" })).toBe(false);
  });
});

describe("isNonInteractiveTrigger", () => {
  it("recognizes skip triggers case-insensitively", () => {
    expect(isNonInteractiveTrigger("CRON", "main:x")).toBe(true);
    expect(isNonInteractiveTrigger("heartbeat", "main:x")).toBe(true);
    expect(isNonInteractiveTrigger("automation", "main:x")).toBe(true);
    expect(isNonInteractiveTrigger("schedule", "main:x")).toBe(true);
    expect(isNonInteractiveTrigger("manual", "main:x")).toBe(false);
    expect(isNonInteractiveTrigger()).toBe(false);
  });

  it("recognizes cron and heartbeat markers inside the session key", () => {
    expect(isNonInteractiveTrigger(undefined, "main:cron:daily")).toBe(true);
    expect(isNonInteractiveTrigger(undefined, "main:heartbeat:tick")).toBe(true);
    expect(isNonInteractiveTrigger(undefined, "main:normal")).toBe(false);
  });
});
