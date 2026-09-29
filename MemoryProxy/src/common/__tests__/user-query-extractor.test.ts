import { describe, expect, it } from "vitest";
import {
  extractUserQueryText,
  isDshRuntimeContextSnapshot,
} from "../user-query-extractor.js";
import { extractLatestUserMessage } from "../../tdai/recorder.js";

describe("isDshRuntimeContextSnapshot", () => {
  it("matches the DSH runtime-context prefix", () => {
    expect(isDshRuntimeContextSnapshot("Current runtime context. cwd=/workspace")).toBe(true);
    expect(isDshRuntimeContextSnapshot("  Current runtime context. policy=danger-full-access")).toBe(true);
  });

  it("does not match a real user question that only mentions the phrase", () => {
    expect(isDshRuntimeContextSnapshot("请解释 Current runtime context. 是什么")).toBe(false);
  });
});

describe("extractUserQueryText", () => {
  it("discards a DSH runtime-context snapshot", () => {
    const raw = [
      "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.",
      "Current DSH file policy: danger-full-access.",
      "cwd=/workspace",
    ].join("\n");
    expect(extractUserQueryText(raw)).toBe("");
  });

  it("strips a standalone system-reminder to empty", () => {
    expect(extractUserQueryText("<system-reminder>internal metadata</system-reminder>")).toBe("");
  });

  it("keeps a real user question", () => {
    expect(extractUserQueryText("请检查这个项目并修复问题")).toBe("请检查这个项目并修复问题");
  });

  it("still extracts an explicit user_query block", () => {
    expect(extractUserQueryText("<user_query>fix the login bug</user_query>")).toBe("fix the login bug");
  });
});

describe("extractLatestUserMessage", () => {
  it("skips DSH metadata and returns the real user prompt", () => {
    const got = extractLatestUserMessage([
      { role: "user", content: "请检查这个项目并修复问题" },
      { role: "user", content: "Current runtime context. cwd=/workspace ..." },
      { role: "user", content: "<system-reminder>internal metadata</system-reminder>" },
    ]);
    expect(got).toEqual({ role: "user", content: "请检查这个项目并修复问题" });
  });

  it("returns null when every user message is harness noise", () => {
    const got = extractLatestUserMessage([
      { role: "user", content: "Current runtime context. cwd=/tmp" },
      { role: "user", content: "<system-reminder>workspace rules</system-reminder>" },
    ]);
    expect(got).toBeNull();
  });
});
