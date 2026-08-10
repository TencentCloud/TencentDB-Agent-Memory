/**
 * tz-09 Ф2b — one reaction per failure class (P9 §4.2).
 *
 * The table in the TZ is the specification; this test IS that table, so a
 * later phase cannot quietly turn "new run" back into "retry".
 */
import { describe, it, expect } from "vitest";
import {
  classifyFailure,
  reactionFor,
  type FailureClass,
} from "./failure-class.js";

describe("failure classes → reactions (tz-09 Ф2b)", () => {
  const table: Array<[FailureClass, string, boolean]> = [
    ["transient-launcher", "new-launch-attempt", false],
    ["invalid-role-output", "attempt-or-terminal", false],
    ["invalid-critic-output", "new-critic-attempt", false],
    ["manifest-conflict", "new-run", true],
    ["partial-apply", "reconcile", true],
    ["timeout-cancel", "kill-no-late-apply", true],
  ];

  it.each(table)("%s → %s", (cls, reaction, terminal) => {
    const r = reactionFor(cls);
    expect(r.reaction).toBe(reaction);
    expect(r.terminalForRun).toBe(terminal);
  });

  it("a manifest conflict never becomes a retry of the same run", () => {
    const cls = classifyFailure({
      stage: "apply",
      message: 'manifest drift: "persona.md" changed since spawn',
    });
    expect(cls).toBe("manifest-conflict");
    const r = reactionFor(cls);
    expect(r.reaction).toBe("new-run");
    expect(r.consumesBudget).toBe(false);
  });

  it("a stale delete is a store conflict, not a bad role output", () => {
    expect(
      classifyFailure({
        stage: "apply",
        message: 'delete target "m_a" was updated since the diff was built',
      }),
    ).toBe("manifest-conflict");
  });

  it("a partial apply reconciles instead of retrying", () => {
    const cls = classifyFailure({
      stage: "apply",
      message: "deleteL1Batch failed",
      partial: true,
    });
    expect(cls).toBe("partial-apply");
    expect(reactionFor(cls).reaction).toBe("reconcile");
  });

  it("timeout and cancel outrank the stage they happened in", () => {
    expect(
      classifyFailure({ stage: "apply", message: "x", timedOut: true }),
    ).toBe("timeout-cancel");
    expect(
      classifyFailure({ stage: "critic", message: "x", cancelled: true }),
    ).toBe("timeout-cancel");
  });

  it("a bad verdict re-runs the critic over the same candidate", () => {
    const cls = classifyFailure({ stage: "critic", message: "bad json" });
    expect(cls).toBe("invalid-critic-output");
    expect(reactionFor(cls).reaction).toBe("new-critic-attempt");
  });

  it("a spawn failure is transient and earns another launch attempt", () => {
    const cls = classifyFailure({ stage: "launch", message: "ENOENT pi" });
    expect(cls).toBe("transient-launcher");
    expect(reactionFor(cls).reaction).toBe("new-launch-attempt");
    expect(reactionFor(cls).consumesBudget).toBe(true);
  });
});
