import { describe, expect, it } from "vitest";

import { isEmptyShellMmdContent } from "./before-agent-start.js";

describe("isEmptyShellMmdContent", () => {
  it("flags the auto-created skeleton as a deletable shell", () => {
    expect(isEmptyShellMmdContent('flowchart TD\n    001-N1["my-task"]')).toBe(true);
  });

  it("preserves a new-format metadata graph (no false delete)", () => {
    const content = [
      '%% mmd-meta: {"taskGoal":"x"}',
      "flowchart TD",
      '001-N1["task<br/>status: doing<br/>summary: s<br/>Timestamp: 2026-06-14T18:39:06+08:00"]',
    ].join("\n");
    expect(isEmptyShellMmdContent(content)).toBe(false);
  });

  it("preserves a legacy-directive metadata graph", () => {
    expect(isEmptyShellMmdContent('%%{ "taskGoal": "x" }%%\nflowchart TD')).toBe(false);
  });

  it("preserves a content-bearing graph even without a metadata header", () => {
    expect(
      isEmptyShellMmdContent('flowchart TD\n    001-N1["task<br/>status: done"]'),
    ).toBe(false);
  });

  it("does not delete an empty file", () => {
    expect(isEmptyShellMmdContent("")).toBe(false);
    expect(isEmptyShellMmdContent("   \n  ")).toBe(false);
  });

  it("preserves a larger metadata-less, marker-less file (>3 lines)", () => {
    expect(isEmptyShellMmdContent("flowchart TD\nA\nB\nC\nD")).toBe(false);
  });
});
