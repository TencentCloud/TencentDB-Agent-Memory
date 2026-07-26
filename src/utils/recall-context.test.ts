import { afterEach, describe, expect, it } from "vitest";

import {
  RECALL_LINE_SEPARATOR,
  applyRecallBudget,
  applySessionRecallDedupe,
  applySessionRecallDedupeDetailed,
  commitSessionRecallDedupe,
  digestRecallLine,
  prepareSessionRecallDedupeDetailed,
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
    const cfg = { dedupeInjected: true, dedupeMode: "skip" as const, dedupeInjectedTtlTurns: 0 };

    expect(applySessionRecallDedupe(lines, "session-a", cfg)).toEqual(lines);
    expect(applySessionRecallDedupe(lines, "session-a", cfg)).toEqual([]);
  });

  it("keeps duplicates independent across sessions", () => {
    const lines = ["- [fact] Use Chinese"];
    const cfg = { dedupeInjected: true, dedupeMode: "skip" as const, dedupeInjectedTtlTurns: 0 };

    expect(applySessionRecallDedupe(lines, "session-a", cfg)).toEqual(lines);
    expect(applySessionRecallDedupe(lines, "session-b", cfg)).toEqual(lines);
  });

  it("allows reinjection after the configured ttl turns", () => {
    const lines = ["- [fact] Use Chinese"];
    const other = ["- [fact] Other memory"];
    const cfg = { dedupeInjected: true, dedupeMode: "skip" as const, dedupeInjectedTtlTurns: 1 };

    expect(applySessionRecallDedupe(lines, "session-a", cfg)).toEqual(lines);
    expect(applySessionRecallDedupe(lines, "session-a", cfg)).toEqual([]);
    expect(applySessionRecallDedupe(other, "session-a", cfg)).toEqual(other);
    expect(applySessionRecallDedupe(lines, "session-a", cfg)).toEqual(lines);
  });

  it("normalizes activity time suffixes out of recall digests", () => {
    expect(digestRecallLine("- [episodic] User prefers concise answers (活动时间: 2026-07-02)"))
      .toBe(digestRecallLine("- [episodic]  user prefers concise answers "));
  });

  it("turns duplicate lines into compact reminders in reminder mode", () => {
    const lines = ["- [fact] Feature flags use config_flags table (活动时间: 2026-07-02)"];
    const cfg = {
      dedupeInjected: false,
      dedupeMode: "reminder" as const,
      dedupeInjectedTtlTurns: 0,
      maxReminderChars: 600,
    };

    expect(applySessionRecallDedupeDetailed(lines, "session-a", cfg).fullLines).toEqual(lines);
    const second = applySessionRecallDedupeDetailed(lines, "session-a", cfg);

    expect(second.fullLines).toEqual([]);
    expect(second.reminderLines).toEqual(["- [fact] Feature flags use config_flags table"]);
    expect(second.skippedCount).toBe(0);
  });

  it("caps duplicate reminder characters", () => {
    const lines = ["- [fact] Feature flags use config_flags table"];
    const cfg = {
      dedupeInjected: false,
      dedupeMode: "reminder" as const,
      dedupeInjectedTtlTurns: 0,
      maxReminderChars: 10,
    };

    expect(applySessionRecallDedupeDetailed(lines, "session-a", cfg).fullLines).toEqual(lines);
    const second = applySessionRecallDedupeDetailed(lines, "session-a", cfg);

    expect(second.reminderLines).toEqual([]);
    expect(second.skippedCount).toBe(1);
  });

  it("does not mark prepared lines as injected until they are committed", () => {
    const lines = ["- [fact] first", "- [fact] second"];
    const cfg = { dedupeInjected: true, dedupeMode: "skip" as const, dedupeInjectedTtlTurns: 0 };

    const preparation = prepareSessionRecallDedupeDetailed(lines, "session-a", cfg);
    expect(preparation.fullLines).toEqual(lines);

    // Abandoning a preparation has no effect on the next decision.
    expect(prepareSessionRecallDedupeDetailed(lines, "session-a", cfg).fullLines).toEqual(lines);

    commitSessionRecallDedupe(preparation, [lines[0]]);
    const afterPartialCommit = prepareSessionRecallDedupeDetailed(lines, "session-a", cfg);
    expect(afterPartialCommit.fullLines).toEqual([lines[1]]);
    commitSessionRecallDedupe(afterPartialCommit);
  });

  it("commits the source digest when a prepared line is truncated by budget", () => {
    const longLine = `- [fact] ${"x".repeat(120)}`;
    const otherLine = "- [fact] other";
    const lines = [longLine, otherLine];
    const cfg = { dedupeInjected: true, dedupeMode: "skip" as const, dedupeInjectedTtlTurns: 0 };

    const preparation = prepareSessionRecallDedupeDetailed(lines, "session-a", cfg);
    const budgeted = applyRecallBudget(preparation.fullLines, {
      maxCharsPerMemory: 0,
      maxTotalRecallChars: 64,
    });
    expect(budgeted).toHaveLength(1);
    expect(budgeted[0]).not.toBe(longLine);

    // The actual prompt receives only the bounded line. The original source
    // digest must nevertheless be what gets recorded for the next turn.
    commitSessionRecallDedupe(preparation, budgeted);
    const next = prepareSessionRecallDedupeDetailed(lines, "session-a", cfg);
    expect(next.fullLines).toEqual([otherLine]);
  });

  it("treats a commit as idempotent", () => {
    const lines = ["- [fact] one"];
    const cfg = { dedupeInjected: true, dedupeMode: "skip" as const, dedupeInjectedTtlTurns: 1 };

    const preparation = prepareSessionRecallDedupeDetailed(lines, "session-a", cfg);
    preparation.commit();
    preparation.commit();

    expect(applySessionRecallDedupe(lines, "session-a", cfg)).toEqual([]);
    expect(applySessionRecallDedupe(lines, "session-a", cfg)).toEqual(lines);
  });

  it("advances the session turn for a successful reminder-only commit", () => {
    const lines = ["- [fact] remembered"];
    const cfg = {
      dedupeInjected: false,
      dedupeMode: "reminder" as const,
      dedupeInjectedTtlTurns: 1,
    };

    const first = prepareSessionRecallDedupeDetailed(lines, "session-a", cfg);
    first.commit();
    const reminder = prepareSessionRecallDedupeDetailed(lines, "session-a", cfg);
    expect(reminder.fullLines).toEqual([]);
    expect(reminder.reminderLines).toEqual(lines);
    reminder.commit([]);

    // The reminder-only turn advances TTL even though it adds no digest.
    expect(applySessionRecallDedupe(lines, "session-a", cfg)).toEqual(lines);
  });
});
