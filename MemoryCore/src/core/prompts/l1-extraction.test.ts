/**
 * Regression guard for the user-name source rule in the L1 extraction prompt.
 *
 * Bug context (#1402): the prompt asked for "用户（[姓名]）" phrasing but never
 * said where the name may come from, so a reasoning model could copy the name
 * of a third party mentioned in the conversation (e.g. a mentor or colleague)
 * and attribute that person's statements to the user. These tests pin the
 * constraint text so the rule cannot silently disappear in a prompt edit.
 */
import { describe, expect, it } from "vitest";
import {
  EXTRACT_MEMORIES_SYSTEM_PROMPT,
  formatExtractionPrompt,
} from "./l1-extraction.js";

describe("L1 chat extraction prompt — user name source rule", () => {
  it("pins the user name to explicit self-introduction or injected profile", () => {
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toContain("姓名归属");
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toMatch(/只能来自用户本人的明确自述/);
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toMatch(/系统注入的用户资料/);
  });

  it("forbids third-party names from being recorded as the user name", () => {
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toMatch(/第三方.{0,20}严禁当作用户姓名/s);
  });

  it("falls back to a generic 用户 reference instead of guessing", () => {
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toMatch(/无法确认用户姓名时[^。]*不得猜测/);
  });

  it("applies the same constraint to scene naming", () => {
    const namingRule = EXTRACT_MEMORIES_SYSTEM_PROMPT.match(/命名规则[^\n]*/)?.[0] ?? "";
    expect(namingRule).toContain("只能来自用户自述");
    expect(namingRule).toContain("第三方");
  });
});

describe("formatExtractionPrompt — previousSceneName passthrough", () => {
  it("keeps injecting the previous scene name unchanged (continuity unaffected by the new rule)", () => {
    const prompt = formatExtractionPrompt({
      newMessages: [{ id: "m1", role: "user", content: "hello", timestamp: Date.now() }],
      previousSceneName: "我（AI）在和用户调试网关配置",
    });
    expect(prompt).toContain("【上一个情境】：我（AI）在和用户调试网关配置");
  });
});
