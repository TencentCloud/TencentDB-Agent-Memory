/**
 * Tests for #706 — the L1 extraction prompt must allow saving the FINAL
 * correction conclusion when it is anchored by a user correction/confirmation,
 * while still filtering one-sided AI output.
 */

import { describe, expect, it } from "vitest";
import {
  EXTRACT_MEMORIES_SYSTEM_PROMPT,
  EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT,
  getExtractMemoriesSystemPrompt,
} from "./l1-extraction.js";

describe("L1 extraction prompt correction-conclusion exception (#706)", () => {
  const chatPrompt = getExtractMemoriesSystemPrompt("chat");

  it("includes the correction-conclusion exception in the chat prompt", () => {
    expect(chatPrompt).toContain("纠正结论例外");
  });

  it("guides the model to write the final correction as '用户确认：…'", () => {
    expect(chatPrompt).toContain("用户确认：[纠正后的最终事实]");
  });

  it("requires source_message_ids to span the user correction + AI confirmation", () => {
    expect(chatPrompt).toContain("同时包含用户的纠正消息与 AI 的确认消息");
  });

  it("bounds the exception to user-grounded facts, not one-sided AI output", () => {
    expect(chatPrompt).toContain("只提取被用户纠正/确认锚定的最终事实");
    expect(chatPrompt).toContain("AI 单方面提出的新方案");
  });

  it("still excludes AI's own behaviour/output outside the exception", () => {
    expect(chatPrompt).toContain("AI助手自身的行为或输出");
    expect(chatPrompt).toMatch(/最终纠正结论.*除外/);
  });

  it("keeps the work/team (code) prompt unchanged", () => {
    // The work prompt already requires human acceptance/confirmation before
    // extracting AI output; it must not carry the chat-specific exception.
    expect(EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT).not.toContain("纠正结论例外");
    expect(EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT).toContain("人类成员采纳、确认");
  });
});
