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
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toMatch(/只能是用户本人的明确自述/);
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toMatch(/系统注入的用户资料/);
  });

  it("forbids third-party names AND non-name junk from the name slot", () => {
    // 2026-09-24 事故：模型绕过旧措辞，把角色/路径/状语塞进姓名括号
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toMatch(/第三方（同事、导师、领导、家人、朋友等）的姓名或称呼/);
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toMatch(/角色标签/);
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toMatch(/路径片段/);
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toMatch(/严禁把以下内容填进姓名括号/);
  });

  it("unknown name → omit the bracket entirely (not a guess)", () => {
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toMatch(/姓名未知时括号直接省略/);
    // 提取句式本身不再强制填括号
    expect(EXTRACT_MEMORIES_SYSTEM_PROMPT).toMatch(/否则省略括号/);
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
