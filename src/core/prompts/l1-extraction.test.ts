/**
 * Pin tests for the L1 extraction prompt's attribution guardrails.
 *
 * The 2026-09-17 production incident: a teacher forwarded a parent's chat
 * messages and the extractor recorded "the user is a mother" — the persona
 * layer compounded it. ba604f5 added speaker-attribution rules to the
 * prompt; these tests ensure no refactor can silently drop them.
 */
import { describe, expect, it } from "vitest";
import { EXTRACT_MEMORIES_SYSTEM_PROMPT } from "./l1-extraction.js";

describe("L1 extraction prompt — attribution guardrails", () => {
  it("keeps the speaker-attribution principle", () => {
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain("说话人归属");
    // Forwarded/quoted third-party self-descriptions must never be
    // attributed to the user.
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain("一律不得写成\"用户……\"");
    // Attribution must not suppress extraction: counterpart-subject
    // episodic memories are the intended outcome for forwarded content.
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain("不得因归属第三方而整体放弃提取");
  });

  it("keeps the persona identity red-line", () => {
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain("身份红线");
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain(
      "仅在用户本人以第一人称明确陈述时提取",
    );
  });

  it("scopes address evidence to the counterpart, excluding forwarded content", () => {
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain("对话另一方对用户的称呼");
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain("转发/引用内容中的称呼除外");
  });
});
