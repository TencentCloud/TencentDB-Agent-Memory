import { afterEach, describe, expect, it } from "vitest";

import {
  RECALL_LINE_SEPARATOR,
  applyRecallBudget,
  applySessionRecallDedupe,
  digestRecallLine,
  resetSessionRecallDedupeForTest,
} from "./recall-context.js";

describe("recall context budget", () => {
  it("leaves recall lines unchanged when budget guards are disabled", () => {
    const lines = ["- [fact] short", "- [fact] another"];

    expect(applyRecallBudget(lines, { maxCharsPerMemory: 0, maxTotalRecallChars: 0 })).toBe(lines);
  });

  it("truncates individual recall lines by code point", () => {
    const lines = ["- [fact] abc😀def"];

    const result = applyRecallBudget(lines, { maxCharsPerMemory: 13, maxTotalRecallChars: 0 });

    expect(Array.from(result[0]).length).toBe(13);
    expect(result[0]).not.toContain("\uFFFD");
  });

  it("applies a total recall budget including separators", () => {
    const lines = [
      "- [fact] one",
      "- [fact] two",
      "- [fact] three",
    ];

    const result = applyRecallBudget(lines, { maxCharsPerMemory: 0, maxTotalRecallChars: 25 });
    const joined = result.join(RECALL_LINE_SEPARATOR);

    expect(joined.length).toBeLessThanOrEqual(25);
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThan(lines.length);
  });
});

describe("session recall dedupe", () => {
  afterEach(() => {
    resetSessionRecallDedupeForTest();
  });

  it("skips duplicate recall lines in the same session", () => {
    const lines = ["- [fact] Use Chinese", "- [fact] Keep answers short"];
    const cfg = { dedupeInjected: true, dedupeInjectedTtlTurns: 0 };

    expect(applySessionRecallDedupe(lines, "session-a", cfg)).toEqual(lines);
    expect(applySessionRecallDedupe(lines, "session-a", cfg)).toEqual([]);
  });

  it("keeps duplicates independent across sessions", () => {
    const lines = ["- [fact] Use Chinese"];
    const cfg = { dedupeInjected: true, dedupeInjectedTtlTurns: 0 };

    expect(applySessionRecallDedupe(lines, "session-a", cfg)).toEqual(lines);
    expect(applySessionRecallDedupe(lines, "session-b", cfg)).toEqual(lines);
  });

  it("allows reinjection after the configured ttl turns", () => {
    const lines = ["- [fact] Use Chinese"];
    const other = ["- [fact] Other memory"];
    const cfg = { dedupeInjected: true, dedupeInjectedTtlTurns: 1 };

    expect(applySessionRecallDedupe(lines, "session-a", cfg)).toEqual(lines);
    expect(applySessionRecallDedupe(lines, "session-a", cfg)).toEqual([]);
    expect(applySessionRecallDedupe(other, "session-a", cfg)).toEqual(other);
    expect(applySessionRecallDedupe(lines, "session-a", cfg)).toEqual(lines);
  });

  it("normalizes activity time suffixes out of recall digests", () => {
    expect(digestRecallLine("- [episodic] User prefers concise answers (活动时间: 2026-07-02)"))
      .toBe(digestRecallLine("- [episodic]  user prefers concise answers "));
  });
});
